use super::*;
use std::task::Poll;

#[cfg(windows)]
#[tokio::test]
async fn embedded_requests_use_the_existing_origin_guard_without_a_listener() {
    let folder = TestDirectory::new();
    let studio = open(folder.0.clone(), &folder.0, Transport::WebView, true).await.unwrap();
    let request = |method: Method, url: String, origin: &str| {
        Request::builder().method(method).uri(url).header("origin", origin).body(Body::empty()).unwrap()
    };
    let resource = format!("{WEBVIEW_ORIGIN}/api/state");
    assert_eq!(serve_request(&studio, request(Method::GET, resource, "")).await.status(), StatusCode::OK);
    let invalid = request(Method::GET, "http://localhost:4318/api/state".into(), "");
    assert_eq!(serve_request(&studio, invalid).await.status(), StatusCode::FORBIDDEN);
    let foreign_write = request(Method::PATCH, format!("{WEBVIEW_ORIGIN}/api/storage"), "https://example.org");
    assert_eq!(serve_request(&studio, foreign_write).await.status(), StatusCode::FORBIDDEN);
}

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("rehearse-test-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        Self(root)
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn media_and_delete_requests_can_finish_while_another_take_is_locked() {
    let root = TestDirectory::new();
    let client = reqwest::Client::new();
    let studio = Arc::new(Studio {
        sessions: Sessions::new(root.0.clone()),
        media: Media::new(&root.0),
        models: Arc::new(Models::new(root.0.clone(), client.clone())),
        transport: Transport::Network(4318),
        running: Default::default(),
        client,
        sample: Value::Null,
        desktop: true,
    });
    let first = Uuid::new_v4().to_string();
    let second = Uuid::new_v4().to_string();
    for id in [&first, &second] {
        let folder = studio.sessions.folder(id);
        fs::create_dir(&folder).await.unwrap();
        fs::write(folder.join("recording.mp3"), b"abcdef")
            .await
            .unwrap();
        let guard = studio.sessions.lock(id).await;
        studio
            .sessions
            .save(
                id,
                json!({"file": "recording.mp3", "mime": "audio/mpeg"}),
                guard,
            )
            .await
            .unwrap();
    }

    let request = |method: Method, path: String| {
        Request::builder()
            .method(method)
            .uri(path)
            .header("host", "127.0.0.1:4318")
            .header("origin", "http://127.0.0.1:4318")
            .header("range", "bytes=1-3")
            .body(Body::empty())
            .unwrap()
    };
    let preparation = studio.sessions.lock(&first).await;
    let pending = handle(
        State(Arc::clone(&studio)),
        request(Method::GET, format!("/api/sessions/{first}/media")),
    );
    tokio::pin!(pending);
    assert!(matches!(futures_util::poll!(&mut pending), Poll::Pending));

    tokio::time::timeout(Duration::from_secs(5), async {
        let response = handle(
            State(Arc::clone(&studio)),
            request(Method::GET, format!("/api/sessions/{second}/media")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(to_bytes(response.into_body(), 3).await.unwrap(), "bcd");
        let response = handle(
            State(Arc::clone(&studio)),
            request(Method::DELETE, format!("/api/sessions/{second}")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(!studio.sessions.folder(&second).exists());
    })
    .await
    .expect("another take should not wait for playback preparation");
    assert!(
        tokio::time::timeout(Duration::from_millis(150), &mut pending)
            .await
            .is_err()
    );
    drop(preparation);
    let response = pending.await;
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
}
