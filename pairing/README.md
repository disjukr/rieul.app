# 네이티브 GPUI 페어링 GUI

데몬의 페어링·정보 창은 `daemon/gui`의 Rust GPUI 프로세스가 담당한다. Node/Bun, GPUiX, Solid 및 JavaScript GUI 의존성은 설치 번들에 포함하지 않는다. 웹 클라이언트의 Solid/Bunja 구성과 데몬의 인증서·페어링 프로토콜은 그대로 유지한다.

지원 플랫폼은 macOS 13 이상 Apple Silicon(arm64)과 Windows x64이다. Intel Mac과 Rosetta 빌드 셸은 지원하지 않으며 설치·빌드 전에 명확한 오류로 중단한다.

## 구조와 실행 계약

- `daemon/gui/src/controller.rs`: 요청 검증, 화면 상태, 세대별 응답 검증. 요청 교체·연결 해제·닫기·종료는 진행 중 확인을 거절한다.
- `daemon/gui/src/transport.rs`: 기존 CBOR 프로토콜과 프로필별 Unix socket/Windows named pipe. 설정 경로 해시와 macOS UID 구분, 중복 실행 활성화를 유지한다.
- `daemon/gui/src/view.rs`: 640×360 GPUI 화면, QR, 복사, 확인 코드 선택, 남은 시간, 오류·완료 표시와 키보드 탐색.
- `pairing/native/macos.m`: 기존 AppKit delegate 전달·트레이·알림·창 표시를 정적으로 연결한다. 알림 권한을 새로 요청하지 않는다.
- `daemon/gui/src/windows_shell.rs`: Win32 트레이·알림·아이콘·설정 열기. 기존 `daemon/windows-close-guard`를 사용하며 WNDPROC에서 UI를 재진입하지 않는다.
- `pairing/scripts/package.mjs`: 고정 GPUI revision과 독립 Cargo.lock으로 빌드하고 실행 파일·자산·라이선스만 묶는다. `bundle.json` v2가 실행 파일과 리소스 해시를 검증한다.

macOS 앱 ID `app.rieul`, `Contents/MacOS/rieul-gui`, Windows `gui/rieul-windows-gui.exe`, 설정·서비스·자동실행 경로는 유지한다. root updater의 별도 서명 manifest와 복구 계약은 변경하지 않는다. Node는 프로토콜 생성 및 패키징의 **빌드 도구**로만 필요하다.

## 빌드와 독립 프로필 실행

저장소 루트에서 Rust 1.99.1, Node 24, 저장소가 지정한 pnpm 10.28.0을 사용한다.

```sh
pnpm install --frozen-lockfile
node pairing/scripts/package.mjs
```

기존 빌드는 `--replace`로 교체한다. 새 번들을 검증한 후 이전 결과를 `.previous-<timestamp>`로 보존하며, 교체는 현재 체크아웃의 `target/` 또는 `tmp/` 안에서만 허용한다.

macOS에서는 설치 bootstrap 대신 내부 GUI를 명시적 테스트 설정으로 실행한다.

```sh
mkdir -p tmp/pairing-review
printf 'listenAddr: 127.0.0.1:19019\ndomain: fixture.invalid\n' > tmp/pairing-review/rieul.yaml
./target/release/Rieul-desktop.app/Contents/MacOS/rieul-gui --config tmp/pairing-review/rieul.yaml --show
```

Windows에서는 `target/release/rieul-windows-gui/rieul-windows-gui.exe --config <테스트 설정> --show` 또는 `pairing/scripts/launch.ps1 -Config <테스트 설정>`을 사용한다. 개발 실행도 명시적인 설정 경로가 필요하다. 상대 경로는 호출자 작업 디렉터리 기준이다.

## 검증

```sh
cargo test --manifest-path daemon/gui/Cargo.toml --lib --locked
node --test pairing/tests/*.test.mjs
RIEUL_GUI_EXECUTABLE="$PWD/target/release/Rieul-desktop.app/Contents/MacOS/rieul-gui" node pairing/scripts/gpui-native-qa.mjs
node pairing/scripts/bundle-qa.mjs --bundle target/release/Rieul-desktop.app
```

QA는 `.invalid` 주소, 별도 프로필과 CBOR 요청을 사용한다. 실제 서비스 등록, 장치 페어링, 설치·업그레이드·제거를 수행하지 않는다. 자동화는 빌드의 `qa` 기능, `RIEUL_PAIRING_AUTOMATION=1`, 명시적 `--config`가 모두 필요하다. native renderer/event dispatch 검증과 실제 OS 입력·알림·트레이 검증은 구분한다.

상세 구현·의존성 및 검증 상태는 [daemon/gui/README.md](../daemon/gui/README.md)를 참조한다. [MIGRATION.md](MIGRATION.md)와 [VERIFICATION.md](VERIFICATION.md)는 이전 GPUiX 구현의 역사적 검증 기록이다.
## Public payload permissions

`public-macos-bundle.json` lists shipped public resources and executable paths.
Unsigned staging normalizes only these paths to readable data (`0644`) or
searchable directories/executables (`0755`), before signing. It does not grant
read access to unknown files, keys, credentials or user profiles. Archive creation
rejects public entries with incorrect modes without repairing a signed app.

macOS CI also extracts a generated update archive into a disposable root-owned
directory, drops UID/GID and supplementary groups, reads every bundled file and
runs the actual native GUI's `--verify-bundle`. This checks access after root
ownership changes; verification as the builder or root alone cannot do so.
