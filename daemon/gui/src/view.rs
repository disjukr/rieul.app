use crate::shell::Shell;
use gpui::{div, img, prelude::*, px, rgb, rgba, *};
use rieul_gui::{
    controller::{Controller, Effect, Info, Route},
    transport::{Event, Listener},
};
use std::{
    sync::{Arc, mpsc},
    time::{Duration, Instant},
};

struct View {
    controller: Controller,
    events: mpsc::Receiver<Event>,
    shell: Shell,
    generation: u64,
    changed: Instant,
    resolved: bool,
    feedback: String,
    copied: bool,
    error: String,
    notification: Option<(u64, u32, Instant)>,
    backdrop: Arc<RenderImage>,
    qr: Option<(String, Arc<RenderImage>)>,
}
impl View {
    fn effects(&mut self, effects: Vec<Effect>, window: &mut Window) {
        for effect in effects {
            match effect {
                Effect::Show => {
                    window.activate_window();
                    self.shell.visible(true);
                }
                Effect::Hide => self.shell.visible(false),
                Effect::Title(title) => window.set_window_title(title),
                Effect::Notify {
                    generation,
                    title,
                    body,
                } => {
                    let token = self.shell.notify(&title, &body);
                    self.notification = Some((generation, token, Instant::now()));
                }
            }
        }
    }
    fn tick(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        while let Ok(event) = self.events.try_recv() {
            let effects = match event {
                Event::Request {
                    proc_id,
                    payload,
                    connection,
                    reply,
                } => self
                    .controller
                    .request(proc_id, &payload, connection, reply),
                Event::Disconnected(id) => self.controller.disconnected(id),
            };
            self.effects(effects, window);
        }
        let events = self.shell.events();
        if events & 1 != 0 {
            let effects = self.controller.close();
            self.effects(effects, window);
        }
        if events & 2 != 0 {
            self.effects(vec![Effect::Show], window);
        }
        if events & 4 != 0 {
            let effects = self
                .controller
                .show_info(self.controller.info.clone())
                .unwrap_or_default();
            self.effects(effects, window);
        }
        if events & 8 != 0 {
            self.controller.dispose();
            cx.quit();
        }
        if let Some((generation, token, started)) = self.notification {
            let result = if token == 0 {
                -1
            } else {
                self.shell.notification_result(token)
            };
            if result != 0 || started.elapsed() >= Duration::from_secs(5) {
                self.notification = None;
                self.effects(
                    self.controller.notification_result(generation, result == 1),
                    window,
                );
            }
        }
        if self.generation != self.controller.generation {
            self.generation = self.controller.generation;
            self.changed = Instant::now();
            self.resolved = false;
            self.feedback.clear();
            self.error.clear();
            self.copied = false;
        }
        cx.notify();
    }
    fn action(
        &mut self,
        action: Action,
        generation: u64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let result = match action {
            Action::Close => {
                let effects = self.controller.close();
                self.effects(effects, window);
                Ok(())
            }
            Action::Info => self
                .controller
                .show_info(self.controller.info.clone())
                .map(|effects| self.effects(effects, window)),
            Action::Copy(value) => {
                cx.write_to_clipboard(ClipboardItem::new_string(value));
                self.copied = true;
                Ok(())
            }
            Action::Config => std::process::Command::new("/usr/bin/open")
                .arg(&self.controller.info.config_path)
                .spawn()
                .map(|_| ())
                .map_err(Into::into),
            Action::Resolve(accepted, cancelled) => {
                if self.resolved {
                    return;
                }
                self.controller.resolve(accepted, generation).map(|_| {
                    self.resolved = true;
                    self.feedback = if cancelled {
                        "Pairing cancelled."
                    } else if accepted {
                        "Approval sent."
                    } else {
                        "That code did not match. Please start pairing again from the client."
                    }
                    .into();
                })
            }
        };
        if let Err(error) = result {
            self.error = error.to_string();
        }
        cx.notify();
    }
    fn button(
        &self,
        id: impl Into<SharedString>,
        label: impl Into<SharedString>,
        action: Action,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        let id = id.into();
        let label = label.into();
        let generation = self.controller.generation;
        let icon = match id.as_ref() {
            "copy-daemon-url" => Some(if self.copied { "check" } else { "clipboard" }),
            "open-config" => Some("external"),
            _ => None,
        };
        let code_button = id.as_ref() == "copy-pairing-code";
        let keyboard_action = action.clone();
        div()
            .id(id.clone())
            .accessibility_id(id)
            .aria_label(label.clone())
            .role(Role::Button)
            .tab_index(0)
            .flex()
            .items_center()
            .justify_center()
            .h(px(28.))
            .px(px(8.))
            .rounded(px(4.))
            .cursor_pointer()
            .hover(|s| s.bg(rgb(0xf7f8fb)))
            .focus_visible(|s| s.border_2().border_color(rgb(0x4f8cff)))
            .on_click(cx.listener(move |this, _, window, cx| {
                this.action(action.clone(), generation, window, cx)
            }))
            .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
                if event.keystroke.key == "enter" || event.keystroke.key == "space" {
                    this.action(keyboard_action.clone(), generation, window, cx);
                    cx.stop_propagation();
                }
            }))
            .when(!code_button && icon.is_none(), |b| b.child(label))
            .when_some(icon, |b, icon| {
                b.child(
                    svg()
                        .path(icon)
                        .size(px(15.))
                        .text_color(if icon == "check" {
                            rgb(0x4f8cff)
                        } else {
                            rgb(0x20242d)
                        }),
                )
            })
    }
    fn property(
        &self,
        label: &'static str,
        value: String,
        action: Action,
        cx: &Context<Self>,
    ) -> Div {
        let button_label = if label == "Config" {
            "Open config"
        } else if self.copied {
            "Daemon URL copied"
        } else {
            "Copy daemon URL"
        };
        div()
            .flex()
            .flex_col()
            .child(
                div()
                    .text_color(rgb(0x667085))
                    .font_weight(FontWeight::BOLD)
                    .line_height(px(18.))
                    .bg(rgb(0xfbfcfe))
                    .px(px(12.))
                    .pt(px(6.))
                    .pb(px(5.))
                    .border_b_1()
                    .border_color(rgb(0xd8dde7))
                    .child(label),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .p(px(12.))
                    .gap(px(8.))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .font_family("Menlo")
                            .line_height(px(16.8))
                            .rounded(px(3.))
                            .border_1()
                            .border_color(rgb(0xd8dde7))
                            .bg(rgb(0xf4f6fa))
                            .px(px(6.))
                            .child(value),
                    )
                    .child(
                        self.button(
                            if label == "Config" {
                                "open-config"
                            } else {
                                "copy-daemon-url"
                            },
                            button_label,
                            action,
                            cx,
                        )
                        .w(px(34.))
                        .h(px(34.))
                        .overflow_hidden(),
                    ),
            )
    }
}
#[derive(Clone)]
enum Action {
    Close,
    Info,
    Config,
    Copy(String),
    Resolve(bool, bool),
}
impl Render for View {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let route = self.controller.route.clone();
        let content = match route {
            Route::Idle(info) | Route::Info(info) => {
                if self
                    .qr
                    .as_ref()
                    .is_none_or(|(url, _)| url != &info.daemon_url)
                {
                    let mut url = url::Url::parse("https://rieul.app/").unwrap();
                    url.query_pairs_mut()
                        .append_pair("daemonUrl", &info.daemon_url);
                    let code = qrcode::QrCode::with_error_correction_level(
                        url.as_str(),
                        qrcode::EcLevel::M,
                    )
                    .unwrap();
                    let width = code.width();
                    let pixels = image::RgbaImage::from_fn(146, 146, |x, y| {
                        let dark = code[(
                            (x as usize * width / 146).min(width - 1),
                            (y as usize * width / 146).min(width - 1),
                        )] == qrcode::Color::Dark;
                        image::Rgba(if dark {
                            [0x32, 0x26, 0x20, 255]
                        } else {
                            [255; 4]
                        })
                    });
                    self.qr = Some((
                        info.daemon_url.clone(),
                        Arc::new(RenderImage::new(vec![image::Frame::new(pixels)])),
                    ));
                }
                div()
                    .flex()
                    .items_center()
                    .flex_1()
                    .gap(px(18.))
                    .p(px(18.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_center()
                            .size(px(168.))
                            .flex_shrink_0()
                            .bg(rgb(0xffffff))
                            .rounded(px(12.))
                            .border_1()
                            .border_color(rgba(0xffffff75))
                            .child(img(self.qr.as_ref().unwrap().1.clone()).size(px(146.))),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .bg(rgb(0xffffff))
                            .border_1()
                            .border_color(rgb(0xd8dde7))
                            .rounded(px(6.))
                            .overflow_hidden()
                            .child(self.property(
                                "Daemon URL",
                                info.daemon_url.clone(),
                                Action::Copy(info.daemon_url),
                                cx,
                            ))
                            .child(self.property("Config", info.config_path, Action::Config, cx)),
                    )
            }
            Route::Code(model) => {
                let remaining = model
                    .expires_in_seconds
                    .saturating_sub(self.changed.elapsed().as_secs());
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .px(px(18.))
                            .py(px(14.))
                            .border_b_1()
                            .border_color(rgba(0xffffff61))
                            .child(
                                div()
                                    .h(px(27.))
                                    .text_size(px(18.))
                                    .font_weight(FontWeight::EXTRA_BOLD)
                                    .child("Pairing code"),
                            )
                            .child(
                                div()
                                    .text_size(px(11.))
                                    .text_color(rgb(0x8a6116))
                                    .bg(rgb(0xfff8df))
                                    .px(px(4.))
                                    .rounded(px(999.))
                                    .border_1()
                                    .border_color(rgb(0xe4c778))
                                    .child(format!("{:02}:{:02}", remaining / 60, remaining % 60)),
                            ),
                    )
                    .child(
                        div().flex().flex_col().flex_1().p(px(16.)).child(
                            self.button(
                                "copy-pairing-code",
                                "Copy pairing code",
                                Action::Copy(model.pairing_code.clone()),
                                cx,
                            )
                            .relative()
                            .h_full()
                            .min_h(px(112.))
                            .flex_1()
                            .rounded(px(12.))
                            .bg(rgb(0xf8f8f8))
                            .child(
                                div()
                                    .absolute()
                                    .right(px(14.))
                                    .top(px(14.))
                                    .flex()
                                    .gap(px(8.))
                                    .when(self.copied, |d| {
                                        d.child(
                                            div()
                                                .text_size(px(11.))
                                                .text_color(rgb(0xffffff))
                                                .bg(rgb(0x20242d))
                                                .p(px(3.))
                                                .rounded(px(4.))
                                                .child("Copied"),
                                        )
                                    })
                                    .child(svg().path("clipboard").size(px(17.))),
                            )
                            .child(
                                div()
                                    .font_family("Menlo")
                                    .text_size(px(42.))
                                    .font_weight(FontWeight::EXTRA_BOLD)
                                    .children(
                                        model
                                            .pairing_code
                                            .chars()
                                            .map(|digit| div().child(digit.to_string())),
                                    )
                                    .flex()
                                    .gap(px(5.04)),
                            ),
                        ),
                    )
            }
            Route::Confirm { model, candidates } => {
                let mut buttons = div().flex().gap(px(10.));
                for candidate in candidates {
                    let accepted = candidate == model.confirmation_code;
                    buttons = buttons.child(
                        self.button(
                            format!("candidate-{candidate}"),
                            candidate,
                            Action::Resolve(accepted, false),
                            cx,
                        )
                        .h(px(58.))
                        .flex_1()
                        .rounded(px(12.))
                        .border_1()
                        .border_color(rgb(0xd8dde7))
                        .bg(rgb(0xf9f9fa))
                        .text_size(px(28.))
                        .font_weight(FontWeight::EXTRA_BOLD),
                    );
                }
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .child(
                        div()
                            .px(px(18.))
                            .py(px(14.))
                            .border_b_1()
                            .border_color(rgba(0xffffff61))
                            .text_size(px(18.))
                            .font_weight(FontWeight::EXTRA_BOLD)
                            .child("Select the code shown on your client."),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .p(px(16.))
                            .gap(px(8.))
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .px(px(14.))
                                    .py(px(9.))
                                    .rounded(px(12.))
                                    .border_1()
                                    .border_color(rgba(0xffffff6b))
                                    .bg(rgba(0xffffff52))
                                    .child(
                                        div()
                                            .text_size(px(11.))
                                            .text_color(rgb(0x667085))
                                            .font_weight(FontWeight::BOLD)
                                            .child("CLIENT"),
                                    )
                                    .child(
                                        div()
                                            .mt(px(2.))
                                            .text_size(px(15.))
                                            .font_weight(FontWeight::EXTRA_BOLD)
                                            .child(if model.client_label.trim().is_empty() {
                                                "Unknown client".into()
                                            } else {
                                                model.client_label.clone()
                                            }),
                                    )
                                    .child(
                                        div()
                                            .flex()
                                            .gap(px(6.))
                                            .mt(px(6.))
                                            .text_size(px(11.))
                                            .child(
                                                div()
                                                    .text_color(rgb(0x4f8cff))
                                                    .child("Wants to connect to daemon →"),
                                            )
                                            .child(model.daemon_url),
                                    ),
                            )
                            .child(buttons)
                            .child(self.feedback.clone())
                            .child(div().flex().flex_1().items_end().child(self.button(
                                "cancel",
                                "Cancel",
                                Action::Resolve(false, true),
                                cx,
                            ))),
                    )
            }
        };
        div()
            .relative()
            .flex()
            .flex_col()
            .size_full()
            .p(px(18.))
            .bg(rgb(0xf4f5f7))
            .text_size(px(12.))
            .line_height(px(18.))
            .text_color(rgb(0x20242d))
            .child(
                img(self.backdrop.clone())
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full(),
            )
            .child(
                div()
                    .relative()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .rounded(px(16.))
                    .border_1()
                    .border_color(rgba(0xffffff75))
                    .bg(rgb(0xf4f4f6))
                    .overflow_hidden()
                    .child(content)
                    .child(self.error.clone())
                    .child(
                        div()
                            .absolute()
                            .right(px(30.))
                            .bottom(px(22.))
                            .flex()
                            .gap(px(8.))
                            .text_size(px(11.))
                            .text_color(rgb(0x667085))
                            .child(self.button("daemon-info", "Daemon info", Action::Info, cx))
                            .child(self.button("hide", "Close", Action::Close, cx)),
                    ),
            )
    }
}
fn backdrop() -> Arc<RenderImage> {
    let pixels = image::RgbaImage::from_fn(1280, 720, |x, y| {
        let mut color = [244., 245., 247.];
        for (cx, cy, stop, opacity, tint) in [
            (0.86_f64, 0.18_f64, 0.29, 0.12, [56., 184., 111.]),
            (0.18, 0.08, 0.31, 0.18, [79., 140., 255.]),
        ] {
            let radius = ((cx.max(1. - cx) * 1280.).hypot(cy.max(1. - cy) * 720.)) * stop;
            let alpha = opacity
                * (1. - (x as f64 - cx * 1280.).hypot(y as f64 - cy * 720.) / radius).max(0.);
            for i in 0..3 {
                color[i] = color[i] * (1. - alpha) + tint[i] * alpha;
            }
        }
        image::Rgba([
            color[2].round() as u8,
            color[1].round() as u8,
            color[0].round() as u8,
            255,
        ])
    });
    Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
}
pub fn run() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    // Prototype requires an explicit fixture config; never silently attaches to installed data.
    let index = args
        .iter()
        .position(|s| s == "--config")
        .ok_or_else(|| anyhow::anyhow!("prototype requires --config <fixture.yaml>"))?;
    let path = std::path::absolute(
        args.get(index + 1)
            .ok_or_else(|| anyhow::anyhow!("missing config path"))?,
    )?;
    let path = path.canonicalize().unwrap_or(path);
    let profile = rieul_daemon_core::config::profile_id_for_config_path(&path);
    let address = std::path::PathBuf::from(format!(
        "/tmp/rieul-gui-profile-{profile}-{}.sock",
        unsafe { libc::getuid() }
    ));
    let runtime = tokio::runtime::Runtime::new()?;
    let Some(listener) = runtime.block_on(Listener::bind(&address))? else {
        return Ok(());
    };
    let (tx, rx) = mpsc::channel();
    runtime.spawn(listener.run(tx));
    let yaml: serde_yaml::Value = serde_yaml::from_str(&std::fs::read_to_string(&path)?)?;
    let domain = yaml
        .get("domain")
        .and_then(|v| v.as_str())
        .unwrap_or("localhost");
    let port = yaml
        .get("listenAddr")
        .and_then(|v| v.as_str())
        .and_then(|s| s.rsplit(':').next())
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(9012);
    let daemon_url = format!(
        "https://{domain}{}",
        if port == 443 && domain != "localhost" {
            String::new()
        } else {
            format!(":{port}")
        }
    );
    let info = Info {
        config_path: path.to_string_lossy().into_owned(),
        daemon_url,
    };
    Application::with_platform(std::rc::Rc::new(gpui_macos::MacPlatform::new(false)))
        .with_assets(Icons)
        .run(move |cx| {
            let bounds = Bounds::centered(None, size(px(640.), px(360.)), cx);
            cx.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    is_resizable: false,
                    show: false,
                    focus: false,
                    titlebar: Some(TitlebarOptions {
                        title: Some("Daemon info".into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                |window, cx| {
                    cx.new(|cx: &mut Context<View>| {
                        let shell = Shell::new(concat!(
                            env!("CARGO_MANIFEST_DIR"),
                            "/../../pairing/assets/tray.png"
                        ))
                        .expect("AppKit shell");
                        shell.visible(args.iter().any(|s| s == "--show"));
                        cx.spawn_in(window, async move |this, cx| {
                            loop {
                                cx.background_executor()
                                    .timer(Duration::from_millis(16))
                                    .await;
                                if this
                                    .update_in(cx, |view, window, cx| view.tick(window, cx))
                                    .is_err()
                                {
                                    break;
                                }
                            }
                        })
                        .detach();
                        View {
                            controller: Controller::new(info),
                            events: rx,
                            shell,
                            generation: 0,
                            changed: Instant::now(),
                            resolved: false,
                            feedback: String::new(),
                            copied: false,
                            error: String::new(),
                            notification: None,
                            backdrop: backdrop(),
                            qr: None,
                        }
                    })
                },
            )
            .unwrap();
        });
    runtime.shutdown_timeout(Duration::from_secs(2));
    Ok(())
}

struct Icons;
impl AssetSource for Icons {
    fn load(&self, path: &str) -> gpui::Result<Option<std::borrow::Cow<'static, [u8]>>> {
        let body = match path {
            "clipboard" => {
                r#"<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>"#
            }
            "external" => {
                r#"<path d="M15 3h6v6M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>"#
            }
            "check" => r#"<path d="m20 6-11 11-5-5"/>"#,
            _ => return Ok(None),
        };
        Ok(Some(std::borrow::Cow::Owned(format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{body}</svg>"#).into_bytes())))
    }
    fn list(&self, _: &str) -> gpui::Result<Vec<SharedString>> {
        Ok(vec!["clipboard".into(), "external".into(), "check".into()])
    }
}
