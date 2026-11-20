//! WebView2 serves the desktop workspace through its host instead of a TCP listener.
use crate::{
    UiEvent,
    server::{self, FileSlice, WEBVIEW_ORIGIN},
};
use anyhow::Result;
use axum::{
    body::{Body, Bytes, to_bytes},
    extract::Request,
    http::{HeaderMap, StatusCode},
    response::Response,
};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    ffi::c_void,
    fmt::Write as _,
    io,
    os::windows::fs::FileExt,
    rc::Rc,
    sync::{Arc, Mutex},
};
use tao::event_loop::EventLoopProxy;
use tokio::{runtime::Handle, sync::mpsc};
use webview2_com::{
    Microsoft::Web::WebView2::Win32::*, WebResourceRequestedEventHandler, take_pwstr,
};
use windows::{
    Win32::{Foundation::*, System::Com::*, UI::Shell::SHCreateMemStream},
    core::{AgileReference, BOOL, HRESULT, HSTRING, Interface, PWSTR, Ref, implement},
};
use wry::{WebView, WebViewExtWindows};

pub(crate) struct Bridge {
    environment: ICoreWebView2Environment,
    pending: Rc<RefCell<HashMap<usize, Pending>>>,
}

struct Pending {
    args: ICoreWebView2WebResourceRequestedEventArgs,
    deferral: ICoreWebView2Deferral,
}

pub(crate) struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    bytes: Bytes,
    file: Option<FileSlice>,
}

impl Reply {
    async fn from_response(response: Response) -> Self {
        let (mut parts, body) = response.into_parts();
        let file = parts.extensions.remove::<FileSlice>();
        match to_bytes(body, u32::MAX as usize).await {
            Ok(bytes) => Self {
                status: parts.status,
                headers: parts.headers,
                bytes,
                file,
            },
            Err(_) => Self::failure(StatusCode::INTERNAL_SERVER_ERROR),
        }
    }

    fn failure(status: StatusCode) -> Self {
        let mut headers = HeaderMap::new();
        headers.insert("content-type", "application/json".parse().unwrap());
        Self {
            status,
            headers,
            bytes: Bytes::from_static(br#"{"error":"Rehearsal could not read this request."}"#),
            file: None,
        }
    }

    fn send(
        self,
        env: &ICoreWebView2Environment,
        args: &ICoreWebView2WebResourceRequestedEventArgs,
    ) -> windows::core::Result<()> {
        let mut headers = String::new();
        for (name, value) in &self.headers {
            if let Ok(value) = value.to_str() {
                let _ = write!(headers, "{name}: {value}\r\n");
            }
        }
        let stream = if let Some(slice) = self.file {
            Some(
                MediaStream {
                    slice,
                    position: Mutex::new(0),
                }
                .into(),
            )
        } else if self.bytes.is_empty() {
            None
        } else {
            Some(unsafe { SHCreateMemStream(Some(&self.bytes)) }.ok_or(E_OUTOFMEMORY)?)
        };
        let reason = HSTRING::from(self.status.canonical_reason().unwrap_or("Rehearsal"));
        unsafe {
            let response = env.CreateWebResourceResponse(
                stream.as_ref(),
                self.status.as_u16().into(),
                &reason,
                &HSTRING::from(headers),
            )?;
            args.SetResponse(&response)
        }
    }
}

impl Bridge {
    pub(crate) fn install(
        webview: &WebView,
        runtime: &Handle,
        studio: Arc<server::Studio>,
        proxy: EventLoopProxy<UiEvent>,
    ) -> Result<Self> {
        let core = unsafe { webview.controller().CoreWebView2()? };
        let environment = unsafe { core.cast::<ICoreWebView2_2>()?.Environment()? };
        let bridge = Self {
            environment,
            pending: Default::default(),
        };
        let pending = bridge.pending.clone();
        let environment = bridge.environment.clone();
        let runtime = runtime.clone();
        let next = Cell::new(0_usize);
        unsafe {
            core.AddWebResourceRequestedFilter(
                &HSTRING::from(format!("{WEBVIEW_ORIGIN}/*")),
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
            )?;
            core.add_WebResourceRequested(
                &WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let request = match prepare(args.Request()?, &runtime) {
                        Ok(request) => request,
                        Err(err) => {
                            eprintln!("Could not read the WebView request: {err:#}");
                            return Reply::failure(StatusCode::BAD_REQUEST)
                                .send(&environment, &args);
                        }
                    };
                    let id = next.get();
                    next.set(id.wrapping_add(1));
                    let deferral = args.GetDeferral()?;
                    pending.borrow_mut().insert(id, Pending { args, deferral });
                    let proxy = proxy.clone();
                    let studio = studio.clone();
                    runtime.spawn(async move {
                        let reply =
                            Reply::from_response(server::serve_request(&studio, request).await)
                                .await;
                        let _ = proxy.send_event(UiEvent::Resource(id, reply));
                    });
                    Ok(())
                })),
                &mut 0,
            )?;
        }
        Ok(bridge)
    }

    pub(crate) fn finish(&self, id: usize, reply: Reply) {
        let Some(Pending { args, deferral }) = self.pending.borrow_mut().remove(&id) else {
            return;
        };
        if let Err(err) = reply.send(&self.environment, &args) {
            eprintln!("Could not return the WebView response: {err}");
            let _ =
                Reply::failure(StatusCode::INTERNAL_SERVER_ERROR).send(&self.environment, &args);
        }
        let _ = unsafe { deferral.Complete() };
    }
}

fn prepare(source: ICoreWebView2WebResourceRequest, runtime: &Handle) -> Result<Request> {
    unsafe {
        let mut uri = PWSTR::null();
        source.Uri(&mut uri)?;
        let mut method = PWSTR::null();
        source.Method(&mut method)?;
        let mut request = Request::builder()
            .uri(take_pwstr(uri))
            .method(take_pwstr(method).as_str());
        let headers = source.Headers()?.GetIterator()?;
        let mut has_header = BOOL::default();
        headers.HasCurrentHeader(&mut has_header)?;
        while has_header.as_bool() {
            let (mut key, mut value) = (PWSTR::null(), PWSTR::null());
            headers.GetCurrentHeader(&mut key, &mut value)?;
            request = request.header(take_pwstr(key), take_pwstr(value));
            headers.MoveNext(&mut has_header)?;
        }
        let body = match source.Content() {
            Ok(stream) => request_body(AgileReference::new(&stream)?, runtime),
            Err(_) => Body::empty(),
        };
        Ok(request.body(body)?)
    }
}

fn request_body(stream: AgileReference<IStream>, runtime: &Handle) -> Body {
    // The UI thread owns the WebView. The worker reads the upload in bounded chunks.
    let (sender, receiver) = mpsc::channel(4);
    runtime.spawn_blocking(move || {
        if let Err(err) = read_upload(stream, &sender) {
            let _ = sender.blocking_send(Err(io::Error::other(err)));
        }
    });
    Body::from_stream(futures_util::stream::unfold(
        receiver,
        |mut receiver| async { receiver.recv().await.map(|part| (part, receiver)) },
    ))
}

fn read_upload(
    stream: AgileReference<IStream>,
    sender: &mpsc::Sender<io::Result<Bytes>>,
) -> windows::core::Result<()> {
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok()? };
    let _apartment = Apartment;
    let stream = stream.resolve()?;
    while !sender.is_closed() {
        let mut bytes = vec![0_u8; 64 * 1024];
        let mut count = 0;
        unsafe {
            stream
                .Read(
                    bytes.as_mut_ptr().cast(),
                    bytes.len() as u32,
                    Some(&mut count),
                )
                .ok()?
        };
        if count == 0 {
            break;
        }
        bytes.truncate(count as usize);
        if sender.blocking_send(Ok(bytes.into())).is_err() {
            break;
        }
    }
    Ok(())
}

// WebView2 can read playback on another thread. Each stream exposes only the
// requested file range and keeps its own position, including across clones.
#[implement(IStream)]
struct MediaStream {
    slice: FileSlice,
    position: Mutex<u64>,
}

#[allow(non_snake_case)]
impl ISequentialStream_Impl for MediaStream_Impl {
    fn Read(&self, output: *mut c_void, count: u32, read: *mut u32) -> HRESULT {
        if !read.is_null() {
            unsafe { read.write(0) };
        }
        if count == 0 {
            return S_OK;
        }
        if output.is_null() {
            return STG_E_INVALIDPOINTER;
        }
        let Ok(mut position) = self.position.lock() else {
            return STG_E_READFAULT;
        };
        let available = self.slice.len.saturating_sub(*position).min(count.into()) as usize;
        if available == 0 {
            return S_FALSE;
        }
        let output = unsafe { std::slice::from_raw_parts_mut(output.cast::<u8>(), available) };
        match self
            .slice
            .file
            .seek_read(output, self.slice.start + *position)
        {
            Ok(actual) => {
                *position += actual as u64;
                if !read.is_null() {
                    unsafe { read.write(actual as u32) };
                }
                if actual == count as usize {
                    S_OK
                } else {
                    S_FALSE
                }
            }
            Err(_) => STG_E_READFAULT,
        }
    }

    fn Write(&self, _: *const c_void, _: u32, _: *mut u32) -> HRESULT {
        STG_E_ACCESSDENIED
    }
}

#[allow(non_snake_case)]
impl IStream_Impl for MediaStream_Impl {
    fn Seek(
        &self,
        offset: i64,
        origin: STREAM_SEEK,
        result: *mut u64,
    ) -> windows::core::Result<()> {
        let mut position = self.position.lock().map_err(|_| STG_E_READFAULT)?;
        let base = match origin {
            STREAM_SEEK_SET => 0,
            STREAM_SEEK_CUR => *position,
            STREAM_SEEK_END => self.slice.len,
            _ => return Err(E_INVALIDARG.into()),
        };
        *position = base.checked_add_signed(offset).ok_or(E_INVALIDARG)?;
        if !result.is_null() {
            unsafe { result.write(*position) };
        }
        Ok(())
    }

    fn Stat(&self, result: *mut STATSTG, _: &STATFLAG) -> windows::core::Result<()> {
        if result.is_null() {
            return Err(STG_E_INVALIDPOINTER.into());
        }
        unsafe {
            result.write(STATSTG {
                r#type: STGTY_STREAM.0 as u32,
                cbSize: self.slice.len,
                grfMode: STGM_READ,
                ..Default::default()
            });
        }
        Ok(())
    }

    fn Clone(&self) -> windows::core::Result<IStream> {
        let position = *self.position.lock().map_err(|_| STG_E_READFAULT)?;
        Ok(MediaStream {
            slice: self.slice.clone(),
            position: Mutex::new(position),
        }
        .into())
    }

    fn SetSize(&self, _: u64) -> windows::core::Result<()> {
        Err(STG_E_ACCESSDENIED.into())
    }
    fn CopyTo(
        &self,
        _: Ref<IStream>,
        _: u64,
        _: *mut u64,
        _: *mut u64,
    ) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn Commit(&self, _: &STGC) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn Revert(&self) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn LockRegion(&self, _: u64, _: u64, _: &LOCKTYPE) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn UnlockRegion(&self, _: u64, _: u64, _: u32) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }
}
