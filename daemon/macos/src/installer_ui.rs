use anyhow::Result;

pub fn show_confirmation_window(title: &str, message: &str) -> Result<bool> {
    #[cfg(target_os = "macos")]
    {
        return Ok(macos_alert::show_confirm(title, message));
    }

    #[cfg(not(target_os = "macos"))]
    {
        println!("{title}\n{message}");
        Ok(false)
    }
}

pub fn show_message_window(title: &str, message: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        macos_alert::show_message(title, message, macos_alert::AlertKind::Info);
        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    {
        println!("{title}\n{message}");
        Ok(())
    }
}

pub fn show_error_window(message: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        macos_alert::show_message("rieul", message, macos_alert::AlertKind::Error);
        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    {
        eprintln!("rieul\n{message}");
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod macos_alert {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSAlert, NSAlertFirstButtonReturn, NSAlertSecondButtonReturn, NSAlertStyle, NSApplication,
        NSModalPanelWindowLevel,
    };
    use objc2_foundation::NSString;

    pub enum AlertKind {
        Info,
        Error,
    }

    pub fn show_message(title: &str, message: &str, kind: AlertKind) {
        let _ = run_alert(title, message, kind, &["OK"]);
    }

    pub fn show_confirm(title: &str, message: &str) -> bool {
        run_alert(title, message, AlertKind::Info, &["Yes", "No"]) == NSAlertFirstButtonReturn
    }

    fn run_alert(
        title: &str,
        message: &str,
        kind: AlertKind,
        buttons: &[&str],
    ) -> objc2_app_kit::NSModalResponse {
        let mtm =
            MainThreadMarker::new().expect("macOS installer UI must be shown on the main thread");
        let app = NSApplication::sharedApplication(mtm);
        #[allow(deprecated)]
        app.activateIgnoringOtherApps(true);

        let alert = NSAlert::new(mtm);
        alert.setAlertStyle(match kind {
            AlertKind::Info => NSAlertStyle::Informational,
            AlertKind::Error => NSAlertStyle::Critical,
        });

        for button in buttons {
            alert.addButtonWithTitle(&NSString::from_str(button));
        }

        alert.setMessageText(&NSString::from_str(title));
        alert.setInformativeText(&NSString::from_str(message));

        let window = alert.window();
        window.center();
        window.setLevel(NSModalPanelWindowLevel);
        window.makeKeyAndOrderFront(None);
        window.orderFrontRegardless();

        let response = alert.runModal();
        if response != NSAlertFirstButtonReturn && buttons.len() == 2 {
            return NSAlertSecondButtonReturn;
        }
        response
    }
}
