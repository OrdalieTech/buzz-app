//! Mouse back/forward buttons and page-swipe gestures for the main window.
//!
//! WKWebView never delivers these inputs to the page, so an NSEvent local
//! monitor sends `buzz:history-back` or `buzz:history-forward` to the main
//! view through the menu's request path. A focused browser page goes back or
//! forward; otherwise the app does, as its Back and Forward buttons would.
//!
//! - `otherMouseUp` button 3/4: mice whose X1/X2 buttons arrive as plain
//!   mouse buttons. A sent release is consumed; the inert press passes through.
//! - `swipe` (`swipeWithEvent:`): three-finger trackpad swipes when "Swipe
//!   between pages" is set to three fingers, and mouse drivers that
//!   synthesize a page-swipe for their buttons. `deltaX > 0` is back. Swipes
//!   pass through so AppKit gesture tracking is undisturbed.
//!
//! Two-finger trackpad and Magic Mouse swipes arrive as phased scroll-wheel
//! events and are not handled here.
use std::ptr::NonNull;

use block2::RcBlock;
use objc2_app_kit::{NSEvent, NSEventMask, NSEventType};
use tauri::{AppHandle, Runtime};

const REQUEST: &str = include_str!("history-request.js");

/// X1 (button 3) is back; X2 (button 4) is forward.
fn button_direction(button: isize) -> Option<&'static str> {
    match button {
        3 => Some("buzz:history-back"),
        4 => Some("buzz:history-forward"),
        _ => None,
    }
}

/// Only a swipe's end event carries its direction; a zero delta is the begin.
fn swipe_direction(delta_x: f64) -> Option<&'static str> {
    if delta_x > 0.0 {
        Some("buzz:history-back")
    } else if delta_x < 0.0 {
        Some("buzz:history-forward")
    } else {
        None
    }
}

// A block keeps the binding out of the page's global scope.
fn request<R: Runtime>(app: &AppHandle<R>, name: &str) -> bool {
    crate::close_menu::send_request(
        app,
        &format!("{{ const historyEvent = \"{name}\";\n{REQUEST}}}"),
    )
}

pub(crate) fn install<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    let handler = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        // AppKit supplies a live event for the duration of this callback.
        let ns_event = unsafe { event.as_ref() };
        match ns_event.r#type() {
            NSEventType::OtherMouseUp => {
                if let Some(name) = button_direction(ns_event.buttonNumber()) {
                    if request(&app, name) {
                        return std::ptr::null_mut();
                    }
                }
            }
            NSEventType::Swipe => {
                if let Some(name) = swipe_direction(ns_event.deltaX()) {
                    request(&app, name);
                }
            }
            _ => {}
        }
        event.as_ptr()
    });
    // The callback returns only the original event or null to consume it.
    let token = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(
            NSEventMask::OtherMouseUp | NSEventMask::Swipe,
            &handler,
        )
    };
    match token {
        // The monitor lives for the whole app.
        Some(token) => std::mem::forget(token),
        None => eprintln!("Could not install Buzz mouse back/forward navigation"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mouse_buttons_3_and_4_go_back_and_forward() {
        assert_eq!(button_direction(3), Some("buzz:history-back"));
        assert_eq!(button_direction(4), Some("buzz:history-forward"));
        for button in [-1, 0, 1, 2, 5] {
            assert_eq!(button_direction(button), None);
        }
    }

    #[test]
    fn swipe_delta_sign_picks_direction_and_begin_events_are_ignored() {
        assert_eq!(swipe_direction(1.0), Some("buzz:history-back"));
        assert_eq!(swipe_direction(0.5), Some("buzz:history-back"));
        assert_eq!(swipe_direction(-1.0), Some("buzz:history-forward"));
        assert_eq!(swipe_direction(-0.5), Some("buzz:history-forward"));
        assert_eq!(swipe_direction(0.0), None);
    }
}
