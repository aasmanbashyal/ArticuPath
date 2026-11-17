//! AppKit pieces of the macOS desktop window: the menu bar, folder picker,
//! close confirmation and error alerts. Everything here runs on the main thread.

use objc2::{MainThreadMarker, rc::Retained, runtime::Sel, sel};
use objc2_app_kit::{
    NSAlert, NSAlertFirstButtonReturn, NSAlertStyle, NSApplication, NSEventModifierFlags, NSMenu,
    NSMenuItem, NSModalResponseOK, NSOpenPanel,
};
use objc2_foundation::{NSString, NSURL};
use std::path::PathBuf;

const APP: &str = "ArticuPath";

/// macOS routes Copy, Paste, Undo and Quit shortcuts through the menu bar, so
/// WKWebView text fields need these standard items to receive them.
pub(crate) fn install_menu() {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let app = NSApplication::sharedApplication(mtm);
    let bar = NSMenu::new(mtm);

    let item = |title: &str, action: Option<Sel>, key: &str| unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            mtm.alloc(),
            &NSString::from_str(title),
            action,
            &NSString::from_str(key),
        )
    };
    let submenu = |title: &str, items: Vec<Retained<NSMenuItem>>| {
        let menu = NSMenu::initWithTitle(mtm.alloc(), &NSString::from_str(title));
        for entry in items {
            menu.addItem(&entry);
        }
        let holder = item(title, None, "");
        holder.setSubmenu(Some(&menu));
        bar.addItem(&holder);
        menu
    };
    let separator = || NSMenuItem::separatorItem(mtm);
    let hide_others = item("Hide Others", Some(sel!(hideOtherApplications:)), "h");
    hide_others.setKeyEquivalentModifierMask(
        NSEventModifierFlags::Command | NSEventModifierFlags::Option,
    );

    submenu(APP, vec![
        item(&format!("About {APP}"), Some(sel!(orderFrontStandardAboutPanel:)), ""),
        separator(),
        item(&format!("Hide {APP}"), Some(sel!(hide:)), "h"),
        hide_others,
        item("Show All", Some(sel!(unhideAllApplications:)), ""),
        separator(),
        // Closing the window runs the same unsaved-take check as the close
        // button, then the event loop exits.
        item(&format!("Quit {APP}"), Some(sel!(performClose:)), "q"),
    ]);
    let redo = item("Redo", Some(sel!(redo:)), "z");
    redo.setKeyEquivalentModifierMask(NSEventModifierFlags::Command | NSEventModifierFlags::Shift);
    submenu("Edit", vec![
        item("Undo", Some(sel!(undo:)), "z"),
        redo,
        separator(),
        item("Cut", Some(sel!(cut:)), "x"),
        item("Copy", Some(sel!(copy:)), "c"),
        item("Paste", Some(sel!(paste:)), "v"),
        item("Select All", Some(sel!(selectAll:)), "a"),
    ]);
    let full_screen = item("Enter Full Screen", Some(sel!(toggleFullScreen:)), "f");
    full_screen.setKeyEquivalentModifierMask(
        NSEventModifierFlags::Command | NSEventModifierFlags::Control,
    );
    submenu("View", vec![full_screen]);
    let window = submenu("Window", vec![
        item("Minimize", Some(sel!(performMiniaturize:)), "m"),
        item("Zoom", Some(sel!(performZoom:)), ""),
        separator(),
        item("Close", Some(sel!(performClose:)), "w"),
    ]);
    app.setMainMenu(Some(&bar));
    app.setWindowsMenu(Some(&window));
}

pub(crate) fn choose_folder() -> Option<PathBuf> {
    let mtm = MainThreadMarker::new()?;
    let panel = NSOpenPanel::openPanel(mtm);
    panel.setCanChooseFiles(false);
    panel.setCanChooseDirectories(true);
    panel.setCanCreateDirectories(true);
    panel.setAllowsMultipleSelection(false);
    panel.setMessage(Some(&NSString::from_str("Choose a recording folder")));
    panel.setPrompt(Some(&NSString::from_str("Choose")));
    if panel.runModal() != NSModalResponseOK {
        return None;
    }
    let url: Retained<NSURL> = panel.URL()?;
    url.to_file_path()
}

fn alert(title: &str, text: &str, buttons: &[&str], style: NSAlertStyle) -> Option<isize> {
    let mtm = MainThreadMarker::new()?;
    let alert = NSAlert::new(mtm);
    alert.setMessageText(&NSString::from_str(title));
    alert.setInformativeText(&NSString::from_str(text));
    alert.setAlertStyle(style);
    for button in buttons {
        alert.addButtonWithTitle(&NSString::from_str(button));
    }
    Some(alert.runModal())
}

pub(crate) fn confirm_close() -> bool {
    alert(
        &format!("Close {APP}?"),
        "A recording is in progress or has not been saved.",
        &["Cancel", "Close"],
        NSAlertStyle::Warning,
    )
    .is_some_and(|choice| choice == NSAlertFirstButtonReturn + 1)
}

pub(crate) fn show_error(title: &str, text: &str) {
    let _ = alert(title, text, &["OK"], NSAlertStyle::Critical);
}

pub(crate) fn open_external(url: &str) {
    let _ = std::process::Command::new("/usr/bin/open").arg(url).spawn();
}
