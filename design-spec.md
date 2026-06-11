# design-spec — cell-grow-online (UI / 디자인 토큰)

단일 출처: `public/tokens.css`(CSS 변수) + `public/tokens.js`(JS 미러). 값/키명 1:1 동기화.
캔버스(ctx)는 CSS 변수를 못 읽으므로 **아트/VFX는 반드시 `tokens.js`에서 색을 import**한다.

## 네임스페이스 (소유권)
| prefix | 소유 | 용도 |
|---|---|---|
| `--brand-*` | 공유(합의 변경) | UI/아트 공통 원천색 |
| `--ui-*` | 디자이너 | DOM UI 색·상태 |
| `--art-*` | 비주얼/VFX | 캔버스 아트색 (실사용은 tokens.js) |
| `--space/--font/--text/--radius/--z/--shadow/--ease/--dur` | 디자이너 | UI 공통 비색상 |

## 아트 색 팔레트 (tokens.js → ART) — CellArt가 사용
- 배경: `ART.bgDeep`, `ART.bgGrid`, `ART.bgGridMajor`, `ART.worldBorder`
- 먹이: `ART.food[0..4]`(다채, 순환) / `foodColor(i)`
- 플레이어 세포: `ART.cellSelf`, 핵 `ART.cellSelfCore`
- 봇 세포: `ART.cellBots[0..5]`(소속별 hue) / `botColor(id)`
- 세포 디테일: `ART.cellMembrane`(멤브레인), `ART.cellNucleus`(핵), `ART.cellOrganelle`(소기관)
- 바이러스(지뢰): `ART.virusFill`, `ART.virusSpike`, `ART.virusGlow`, 분열탄 `ART.virusShot`
- 위험/이펙트: `ART.danger`, W로 뿌린 먹이 `ART.eject`

> 성장이 색뿐 아니라 형태(핵/소기관 디테일)로 읽히도록, 멤브레인·핵·소기관 색을 분리 제공.

## DOM 구조 / hook 계약 (프론트와 합의 완료)
- 레이어: `#game`(canvas, z:0) → `#ui-root`(z:10, `pointer-events:none`; 버튼/입력만 `auto`)
- 화면 전환: `.is-hidden`(display:none) 토글. HUD 경고: `#hud.is-warning`.
- 클래스 프리픽스: UI=`ui-`, 게임 DOM=`game-`.

| 영역 | hook |
|---|---|
| 시작 | `#start-nick`(input) `#start-play`(btn) `#start-error`(span) |
| HUD | `#hud-mass` `#hud-rank` `#hud-cells` / `#skill-boost` `#skill-boost-cd`(width %) / `#hud-hints` |
| 리더보드 | `#leaderboard` > `#lb-list` > `li.ui-lb__row[data-rank]`(rank/name/mass), 내 행 `.is-self` |
| 미니맵 | `#minimap`(크기 `--ui-minimap-size` px) > `#minimap-canvas`(프론트가 DPR 보정 렌더) |
| 사망 | `#screen-dead`(.is-hidden) `#dead-mass` `#dead-rank` `#dead-time` `#dead-respawn` |
| 연결 | `#net-status`(.is-hidden, 끊기면 노출) |

## 인터랙티브 상태 (모두 정의됨)
- 버튼 `.ui-btn`: 기본 / `:hover` / `:active` / `:disabled` / `.is-locked`(🔒, 쿨다운·조건미충족) / `.is-warning`. 보조 `.ui-btn--ghost`. 최소 48px.
- 입력 `.ui-input`: 기본 / `:focus`(링) / `.is-error`(`aria-invalid`). 최소 52px.
- `:focus-visible` 키보드 포커스 링 별도.

## 가독성 규칙
- 숫자(질량·순위·리더보드·사망스탯)는 `font-mono` + `tabular-nums`.
- 텍스트/배경 대비: `--ui-text-primary`(#eaf6ff) on 어두운 패널.
- 반응형: ≤640px에서 미니맵 120px·리더보드 축소·HUD 여백 축소, ≤480h에서 힌트바 숨김.

## 성공 기준 (검증 완료 — node 정적 검증)
- style.css var() 전부 tokens.css에 정의(누락 0), 하드코딩 hex/rgb 0 → 토큰 커버리지 100%.
- brand 색 css↔js 1:1 일치.
- `#ui-root` pointer-events:none(캔버스 입력 통과), z-order 배경0<오버레이10<화면30<토스트40.
- 약속한 hook id 전부 존재, 정적 서빙 200.

## 파일
- `public/tokens.css`, `public/tokens.js`, `public/style.css`, `public/index.html`(셸+#ui-root 마크업), `design-spec.md`
