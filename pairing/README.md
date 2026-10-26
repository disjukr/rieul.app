# GPUiX + Solid 페어링 유틸리티

데몬에 붙어 있는 페어링 도구다. 터미널·도킹 워크벤치와 별개이며 인증서/페어링 프로토콜은 데몬의 기존 구현을 사용한다. 현재 코드의 기본 데스크톱 실행과 패키징이 이 도구를 사용한다. 이전 런타임 소스·설정·fallback을 제거했으며 최종 동일 SHA 검증과 main 통합을 진행 중이다.

## 구조와 계약

- `src/host.ts`, `src/ipc.ts`, `src/profile.ts`: Node `node:net` named pipe/Unix socket. 정규화한 설정 경로의 SHA-256 앞 12바이트로 기존 프로필 ID와 엔드포인트를 유지한다. macOS는 UID도 구분한다. 하나의 전역 앱 잠금은 사용하지 않는다.
- `src/controller.ts`, `src/validation.ts`: 네 라우트, 네 바인딩(`getSnapshot`, `openConfig`, `showDaemonInfo`, `resolvePairingConfirmation`)과 snapshot 이벤트를 유지한다. 잘못된 요청은 진행 중 요청을 교체하지 않는다. 교체·연결 해제·닫기·종료는 확인 요청을 거절하고 오래된 응답은 무시한다.
- `src/main.tsx`, `src/view.tsx`: GPUiX/Solid 0.11.0과 Solid 1.9.15. Bun이 UI를 실행하고 Node 부모와 전용 IPC로 통신한다. Node/Bun의 Windows 소켓 반닫기 동작 차이 때문에 데몬 IPC는 Node가 담당한다.
- `native/windows.rs`, `src/windows*.ts`: Rieul 소유 close guard, 트레이, 아이콘과 창 표시. Windows 런처의 Job이 부모·호스트·UI를 소유해 강제 종료 후 자식과 런타임 잠금을 정리한다.
- `native/macos.m`, `src/macos.ts`: AppKit delegate 전달, close-to-hide, NSStatusItem, 트레이 이벤트와 알림. 기존 알림 허용 상태만 조회하며 새 권한을 요청하지 않는다. 미허용/실패 시 창을 표시한다.
- `scripts/package.mjs`, `runtime-lock.json`, `daemon/gui-launcher`: 공식 런타임 아카이브 해시와 버전/아키텍처를 고정한다. 번들 런처는 절대 경로와 파일 해시를 확인한다. Node/Bun 설치나 PATH 탐색이 필요 없다. 상대 `--config`는 호출자 디렉터리를 기준으로 해석한다.

## 빌드와 독립 프로필 실행

저장소 루트에서 실행한다. 빌드 도구 의존성과 실제 사용자 설치/서비스 실행은 별개다.

```sh
pnpm install --frozen-lockfile
node pairing/scripts/package.mjs
```

기존 빌드가 있으면 `--replace`를 사용한다. 새 번들을 검증한 뒤 기존 결과를 `.previous-<timestamp>`에 보존하며, 교체는 이 체크아웃의 `target/`·`tmp/` 안에서만 허용한다.

Windows:

```powershell
New-Item -ItemType Directory -Force tmp/pairing-review | Out-Null
Set-Content tmp/pairing-review/rieul.yaml "listenAddr: 127.0.0.1:19019`ndomain: fixture.invalid"
./target/release/rieul-windows-gui/rieul-windows-gui.exe --config tmp/pairing-review/rieul.yaml --show
```

macOS (설치 bootstrap을 실행하지 않는 내부 GUI fixture):

```sh
mkdir -p tmp/pairing-review
printf 'listenAddr: 127.0.0.1:19019\ndomain: fixture.invalid\n' > tmp/pairing-review/rieul.yaml
./target/release/Rieul-desktop.app/Contents/MacOS/rieul-gui --config tmp/pairing-review/rieul.yaml --show
```

Intel macOS는 패키저가 고정한 공식 GPUiX 소스를 자동으로 빌드한다. upstream Rust toolchain과 submodule을 사용하며 별도 터미널 작업의 패치를 복사하지 않는다. 빌드에 시간이 걸린다.

`pnpm --dir web desktop:build:windows` / `desktop:build:macos`도 같은 번들 빌드를 호출한다. 개발 실행은 명시적인 개발 프로필만 사용한다. `pairing/scripts/launch.ps1`의 기본 경로는 동봉 EXE이며, 명시적인 `-Node`와 `-Bun`을 함께 지정하는 경우만 소스 실행을 허용한다.

## 검사

```sh
cd pairing
bun install --frozen-lockfile
bun run check
bun run test
```

Windows fixture QA는 `RIEUL_GUI_EXECUTABLE`, `RIEUL_PAIRING_BUN`에 해당 번들의 절대 경로를 설정한 뒤 `node scripts/native-qa.mjs`로 실행한다. `RIEUL_PAIRING_EMPTY_PATH=1`은 자식 앱의 PATH와 홈/캐시를 격리한다. `node scripts/bundle-qa.mjs --bundle <repo-tmp-or-target-bundle> --lifecycle`은 고의 손상/경로 탈출 거부와 강제 종료 뒤 파일 잠금 해제를 검사하므로 폐기 가능한 빌드만 지정한다.

QA는 가짜 `.invalid` 상대, 별도 설정과 CBOR 요청만 사용한다. 실제 장치 페어링, 자격 증명, 서비스 등록, 자동시작 설치는 수행하지 않는다. 네이티브 자동화는 `RIEUL_PAIRING_AUTOMATION=1`일 때만 켠다.

실제 OS 트레이 팝업 선택, 알림이 화면에 보이는지, 연결된 편집기 화면은 지원되는 네이티브 컴퓨터 제어 도구가 없어 미검증이다. 직접 메뉴 핸들러 호출을 이 검증으로 계산하지 않는다. 설치·업그레이드·제거 및 Developer ID/notarization도 단순 압축 해제 검사와 구분한다. 최신 결과는 [VERIFICATION.md](./VERIFICATION.md), 진행/승인 제한은 [MIGRATION.md](./MIGRATION.md)에 기록한다.
