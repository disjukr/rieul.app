# 검증 기록

현재 이관은 진행 중이며 최종 동일 SHA의 main 통합·CI 확인과 CEF fallback 제거가 완료되지 않았다. 이전 opt-in 결과와 기본 경로 전환 결과를 구분한다. 진행 상황과 승인 제한은 [MIGRATION.md](./MIGRATION.md)에 기록한다.

## 실제 통과한 검사

| 검사                        | 확인된 결과                                                                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 컨트롤러                    | 9개 테스트, 468 assertion: 유효성 경계, 교체/취소, 오래된 승인, 알림 fallback, 네 바인딩, 프로필 분리                                                                       |
| Node IPC/도구               | 7개 테스트: 실제 named pipe, 반닫기, 잘못된 activation 응답, 두 프로필, 불완전 요청 timeout, 종료 시 명시적 거절 응답, Mach-O 파서 회귀                                     |
| Rust 번들 런처              | 2개 테스트 통과; 실제 번들 손상·경로 탈출 거부는 별도 실행 검사로 확인                                                                                                      |
| Windows 자체 포함 번들      | 빈 PATH·홈·캐시에서 DirectX GPUiX 실행. 반복 교체/승인/취소 3회, 실제 WM_CLOSE 숨김·재열기, 연결 끊김, 중복 활성화, 창 아이콘·타이틀바 상태, Quit 중 대기 요청의 false 응답 |
| 상대 설정 경로              | 호출자 기준 상대 경로로 시작하고 같은 절대 경로로 중복 활성화. 원래 프로필 named pipe와 일치                                                                                |
| 강제 종료/파일 잠금         | 무결성·traversal 오류 거부, 런처 강제 종료 후 UI 자식 종료, 런타임 쓰기 잠금 해제. bundle4에서는 67ms 뒤 잠금 해제 확인                                                     |
| 공백/한글 빌드 경로         | `tmp/경로 공백/pairing`에 소스를 복사해 실제 Node/Solid 빌드 성공                                                                                                           |
| Windows MSI 후보            | 3,752 GUI 파일 추출·해시 대조 성공. 설치하지 않음                                                                                                                           |
| Windows 일반 MSI 빌드       | SkipBuild 없이 새 기본 빌드 성공, 3,755 GUI 파일 추출·SHA-256 대조 성공. 설치하지 않음                                                                                      |
| Windows MSI/MSIX CI         | run40300524070 Windows 작업 성공: 무서명 생성, MSI 추출·대조, MSIX 추출 GUI 무결성 검증                                                                                     |
| Windows 네이티브 CI         | run40303773339 Windows 작업 성공: 추가된 lifecycle 및 실제 네이티브 반복 QA, 후보 설치 패키지 검증                                                                          |
| macOS ARM64/Intel 기본 번들 | run40303773339에서 두 아키텍처의 전체 Mach-O deployment target 검사, 브리지 fixture, 번들 손상 경계, GPUiX/AppKit 실제 반복 수명주기 통과                                   |
| 기존 웹 회귀                | Node 웹/코드젠25개, 웹·도구·코드젠 타입, Vite 빌드 통과. 최종 통합 SHA에서는 재확인 필요                                                                                    |
| 개발 프로세스 범위          | Windows 가짜 CIM10개 / macOS 순수 shell8개: 다른 체크아웃·프로필·접두사·포트를 종료 대상으로 선택하지 않음. 실제 개발 서비스 미실행                                         |

최신 로컬 전체 UI 결과: [artifacts/qa-1793010219402/evidence.json](./artifacts/qa-1793010219402/evidence.json). `tmp/complete-bundle-5`가 해당 실행에 사용됐다. 산출물과 fixture는 Git에 커밋하지 않는다.

## 실패를 확인하고 수정한 항목

- Windows Node의 verbatim 경로 시작 실패: 런처 경로 정규화 후 통과.
- GUI 초기 flush 전에 automation을 켠 QR bounds0: mount 뒤 활성화 및 실제154×154 확인.
- macOS fixture 종료 시 NSWindow 이중 해제: fixture의 releasedWhenClosed 설정 수정 후 통과.
- Intel 공식 소스가 상위 Cargo workspace로 잘못 들어감: runner 임시 디렉터리에 격리한 뒤 컴파일 통과.
- Intel screenshot이 production feature build에서 불가: 배포된 공식 test-support 기능으로 빌드한 뒤 기본 UI QA 통과.
- Node24의 macOS 최소13.5: 동봉 Node22.22.0으로 변경. 검사 도구의 링커 버전 오인도 회귀 테스트와 함께 수정.
- AppKit bridge가 SDK 기본 타깃15.0을 기록함: 명시적인13.0 타깃 후 두 아키텍처 전체 검사 통과.
- macOS PKG 앞 daemon build에서 tsx 누락: CI에 루트 pnpm 의존성 설치 추가. 이 수정 후 PKG 결과는 아직 대기.
- 상대 --config가 앱 디렉터리 기준으로 변함: 런처의 불필요한 cwd 변경 제거. Windows 전체 QA 통과, 수정 후 macOS 재검사 대기.
- 종료 시 거절 응답 전에 소켓이 파기될 수 있음: 제한 시간 내 응답 flush 후 종료하도록 수정. 실제 파이프 및 Windows 전체 UI QA 통과.

## 아직 통과했다고 말하지 않는 범위

- 최신 소스의 기본 MSI/MSIX/PKG 빌드·서명·추출 실행에 대한 동일 SHA CI.
- macOS ad-hoc/hardened runtime PKG 추출 후 실제 UI 반복 실행, DMG 전체 생성 경로. Developer ID 및 notarization은 실행하지 않았다.
- macOS13.0 실제 OS 실행. 확인한 것은 바이너리의 최소 타깃과 macOS15 CI에서의 실행이다.
- 실제 MSI/MSIX/PKG 설치·업그레이드·제거, 서비스/LaunchAgent/자동시작 등록. 수행하지 않았다.
- 실제 OS 트레이 팝업을 열어 항목 선택, 화면에 표시된 알림, 연결된 기본 편집기 화면. CUA native API가 비활성화돼 지원되는 조작 수단이 없다. Win32/AppKit 메뉴 명령 전달 검사는 이 UI 증명과 다르다.
- 다른 Windows 사용자/무결성 수준에서의 named pipe ACL 검증. 기존 프로필 identity와 OS 기본 ACL 모델을 유지하며 새 권한을 부여하지 않았다.

실제 장치·계정·인증정보·사용자 데몬에는 접근하지 않았다. 실제 pairing 승인, autostart 설치, 시스템 보안 설정 변경은 하지 않았다. CEF fallback 제거는 승인 검토가 한 차례 거부해 유지 중이며, 새 검증 근거 전 재시도하지 않았다.
