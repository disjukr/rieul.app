# 검증 기록 — 2026-10-26

격리 체크아웃: `C:\Users\user\Documents\Codex\2026-10-26\task-5\rieul-pairing`

복제 시 origin/main: `a7ba1168bc2a3e732f33ad8a5fa08d92aee2bb55`. 다른 task의 체크아웃·빌드·네이티브 패치는 수정하거나 복사하지 않았다. 기존 파일 변경 없이 `pairing/`만 추가했다. 기본 CEF와 배포 런처는 유지했다.

## 실행 환경과 의존성

Windows x64, Intel Arc Direct3D 11.1. Bun 실제 버전 1.3.9, Node 26.11.1 및 최종 스테이징 Node 24.13.0. 자체 bridge는 설치된 공식 Rust 1.97.1을 직접 지정해 컴파일했다. 전역 툴체인 설정은 바꾸지 않았다.

`@gpuix/native`, `@gpuix/solid` 모두 출시 버전 `0.11.0`. terminal/input patch는 사용하지 않았다. 설치된 출시 addon SHA-256:

`f367ebc0a8b86732a50194d9fc84efdef253c74cf942b3b0d0fe08af91fb6482`

자체 `native/bin/rieul_pairing_windows.dll` SHA-256:

`cd790aebd1b63653f10d0bc347fe07cfd423de9c6514865cc298e3ef2a6f43ea`

## 통과한 검사

| 범위                 | 결과                                                                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 새 패키지 TypeScript | `tsc --noEmit` 통과                                                                                                                                                                                                    |
| 순수 요청/상태       | Bun 테스트 6개 통과: 교체, 이전 화면 클릭 차단, 취소/close/dispose, 알림 실패와 오래된 fallback, 네 바인딩/라우트, 후보 생성, 프로필 식별, malformed 요청의 상태 불변성                                                |
| 실제 Node IPC        | 테스트 5개 통과: 분할 요청, 반닫기 응답, 중복 활성화, 연결 해제, 파이프 정리, 서로 다른 두 프로필의 활성화/확인 격리, 잘못된/다른 stream/잘린 활성화 응답 거부, 중복 dispose, 5초 미완성 연결 timeout과 장기 확인 유지 |
| 새 소스 lint         | 저장소 ESLint 규칙으로 pairing/src, tests, scripts 검사 통과. 규칙 완화/disable 없이 explicit any 제거                                                                                                                 |
| Windows native       | source, 컴파일 번들, 자체 production 의존성을 가진 독립 stage에서 통과                                                                                                                                                 |
| 반복 확인            | fake 요청에서 교체→확인→취소를 각 3회 반복. 실제 장치는 승인하지 않음                                                                                                                                                  |
| 창 수명주기          | 실제 `WM_CLOSE`로 hide; 보류 요청 거절; activate IPC 및 트레이 callback 메시지로 재표시                                                                                                                                |
| 트레이 종료          | 해당 fixture 트레이 HWND에 표준 Quit `WM_COMMAND`를 보내 실제 callback, host/server/UI 종료 확인                                                                                                                       |
| 스테이징             | Solid universal plugin으로 Node/Bun 번들 빌드. 새 디렉터리에 DLL/아이콘/고정 production 의존성 복사 및 설치 통과                                                                                                       |
| PowerShell 런처      | 최종 stage의 `launch.ps1`가 같은 fixture 프로필의 기존 인스턴스를 활성화하고 0으로 종료                                                                                                                                |
| 기존 TypeScript      | web build config, tools config, scripts config 모두 통과                                                                                                                                                               |
| 기존 Node 회귀       | 기존 web/codegen 테스트 25개 통과                                                                                                                                                                                      |
| 기존 웹 빌드         | Vite production build 통과. 기존 chunk 크기/UnoCSS 중복 import 경고 존재                                                                                                                                               |
| 기존 daemon-core     | `cargo test -p rieul-daemon-core --locked --offline`: 44개 통과                                                                                                                                                        |
| 기존 브라우저 UI     | 오프라인 fixture 4개 통과. Playwright 전용 Chromium이 없어 설치된 Chrome channel/임시 프로필 사용                                                                                                                      |

첫 Bun pipe 반닫기 응답 실패는 Node IPC 호스트 분리로 해결했다. 숨김 창 초기화 전에 automation bounds가 요청되는 경합은 UI 초기 마운트/flush 후 명시적으로 automation을 켜도록 해결했다. 긴 설정 경로가 QR 폭을 줄이던 문제는 QR flex shrink 금지 및 정보 영역 최소 폭 제한으로 수정했고 실제 154×154 bounds를 검사한다.

## 최종 산출물

독립 실행 디렉터리: `pairing/stage/review-final/`

최종 증거: [artifacts/qa-1792997981994/evidence.json](./artifacts/qa-1792997981994/evidence.json)

- [daemon info / QR](./artifacts/qa-1792997981994/daemon-info.png)
- [pairing code](./artifacts/qa-1792997981994/pairing-code.png)
- [confirmation](./artifacts/qa-1792997981994/confirmation.png)
- [native stderr](./artifacts/qa-1792997981994/stderr.log)

`stage/`, `artifacts/`, DLL 및 node_modules는 생성물로 git에서 제외한다. 초기 수동 smoke의 fixture host도 종료했으며 최종 검사에서 이 작업 경로의 Bun UI 프로세스가 남지 않았다.

이 환경의 명시적 런처 예시:

```powershell
./pairing/stage/review-final/launch.ps1 `
  -Config ./tmp/pairing-fixture/rieul.yaml `
  -Node C:/Users/user/AppData/Local/mise/installs/node/24.13.0/node.exe `
  -Bun C:/Users/user/AppData/Local/mise/installs/bun/1.3.6/bin/bun.exe `
  -Show
```

경로의 `1.3.6`은 설치 디렉터리 이름이며 실행 파일이 보고한 실제 버전은 1.3.9다. 검증은 모두 별도 fixture 설정과 `.invalid` daemon URL, 가짜 CBOR 요청을 사용했다. 실제 데몬 서비스나 WebTransport pairing API는 호출하지 않았다.

## 남은 한계

- macOS는 공통 플랫폼 계약, AppKit C ABI 소스, Bun 어댑터 및 build script만 추가했다. Cocoa SDK가 없는 Windows에서 native 컴파일·delegate 수명·AppKit loop/서명/패키징을 검증하지 못했다. 새 macOS 코드는 entry에서 선택되지 않고 호스트는 명시적으로 실행을 거부하므로 기존 CEF 경로를 유지한다.
- 트레이의 실제 popup을 열고 사람이 메뉴를 선택하는 end-to-end 검증은 완료하지 못했다. 메뉴 대상으로 보낸 키 메시지와 UI Automation 선택 시도는 통과 증거로 계산하지 않았다. 표준 메뉴 command callback과 정리만 native 테스트로 통과했다. 기존 popup 반환 처리 코드는 유지했다.
- Explorer 재시작 복구는 소스에 유지되어 있지만 실제 Explorer 재시작은 하지 않았다.
- native balloon 호출 성공과 JS 실패 fallback은 확인했다. OS가 알림을 실제로 표시하는지/사용자 클릭을 전달하는지는 미검증이다.
- 설정 열기는 네 바인딩/host 전달 및 `ShellExecuteW` 구현을 포함하지만 기본 연결 앱을 실제 띄우는 end-to-end 검증은 하지 않았다. Clipboard도 구현했으나 기존 사용자 clipboard를 건드리는 native QA는 하지 않았다.
- CEF native 재빌드, 기존 MSI/PKG 생성 및 설치는 실행하지 않았다. 기존 파일/기본 경로는 변경하지 않았고, 새 독립 stage/런처만 smoke했다.
- 기본 전환, CEF 삭제, push, 서비스 등록, autostart/실제 장치 접근 권한 변경은 하지 않았다. 남은 native parity 검토 후 별도 결정해야 한다.

## 최종 코드/권한 경계 리뷰

자체 2차 소스 리뷰에서 malformed pairing-code payload를 decode하기 전에 기존 확인을 취소하던 순서를 발견해 수정했다. 잘못된 요청은 기존 pending route/generation/resolver를 변경하지 않는 테스트를 추가했다. 활성화는 이제 64 KiB 이하의 완전한 CBOR 응답, 정상 response/end kind와 stream ID 1을 확인한다. 임의 바이트·truncation·다른 stream은 활성화 성공으로 인정하지 않는다. 미완성 요청에는 5초 timeout을 두지만 완전한 사용자 확인 요청에는 timeout을 해제한다. IPC dispose도 idempotent하다.

Node named pipe는 기존과 같은 OS 기본 ACL과 프로필별 경로를 사용하며 공개 TCP listener나 전역 앱 lock을 추가하지 않았다. 실제 다른 사용자/무결성 수준에서 ACL을 공격하는 테스트는 수행하지 않았다. Unix stale socket 정리는 socket 타입과 현재 uid 소유권을 검사하지만 macOS 런타임 검증은 별도로 남는다. config-open 대상은 incoming daemon payload의 표시 경로가 아니라 호스트가 시작 시 안정화한 config identity다. ShellExecute에는 shell 문자열 보간을 하지 않고 clipboard 데이터도 고정 명령의 stdin으로 전달한다. 인증서/페어링 daemon 프로토콜·접근 권한을 변경하는 코드는 없다.

Windows 창 탐색과 fixture command 대상은 PID로 한정했고 Rust close guard가 GPUiX UI thread의 메시지를 처리하므로 JS callback을 GPUiX thread로 넘기지 않는다. 모든 native QA는 새 fixture 설정 및 `.invalid` URL로 한정했다. `NAPI_RS_NATIVE_LIBRARY_PATH` override가 있으면 native QA가 중단되며 이번 검사 환경에는 override가 없었다.

현재 CUA 도구의 native computer API는 비활성화되어 있고 callable node_repl/Sky 도구도 없다. 따라서 실제 tray popup 선택·보이는 OS notification·연결된 외부 editor의 화면 확인은 지원되는 UI 표면으로 수행할 수 없었다. 직접 `WM_COMMAND`/native automation 결과를 OS 사용자 선택의 증거로 세지 않는다. 외부 editor를 보이지 않게 실행해 성공으로 간주하지도 않았다.

변경은 `pairing/`에만 있다. 기존 CEF, root workspace/default scripts, MSI/PKG 및 서비스/autorun 파일은 byte-for-byte 그대로다. DLL/.node/stage/fixtures/인증서가 git에 들어가지 않는 것을 확인했다. 따라서 **opt-in 소스 커밋의 main 통합은 가능**하나 새 macOS 소스는 미검증이고 전체 native parity는 완료되지 않았다. 기본 전환은 불가하며 push는 parent 리뷰까지 보류한다. 이 기록은 자체 2차 리뷰 결과로, 별도 독립 리뷰어 승인을 대신하지 않는다.
