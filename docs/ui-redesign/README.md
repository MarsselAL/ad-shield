# UI refresh: white clear glass (2026-11-25)

Popup (`src/popup/`) and settings page (`src/options/`) restyled as bright white "clear glass"
(iOS 26 / visionOS style) in both colour schemes. Same layout, same controls, same ids and
classes, same behaviour. CSS only, plus one class toggle in `popup.js` (`.bump` on a stat number
when its count changes). Tokens: `docs/DESIGN-v2.md`, section "UI".

| Area | Change |
|---|---|
| Backdrop | Warm white with soft coral / red / peach / lilac blobs drifting (26-44 s); in dark a deeper plum dusk with a red glow behind the same light glass. |
| Panels and cards | Translucent white (blur 30 px, saturate 190 %), specular rim brightest at the top edge (`.panel::after`, `.card::after`), top sheen, inner glow, 0.5 px hairline, soft layered shadows, radii 24 / 20 / 16. |
| Dark mode | No more navy panels: the glass stays light with dark text in `prefers-color-scheme: dark` (more white for AA); only the backdrop and the settings header text change. `color-scheme: light` so form controls match. |
| Type | SF Pro Text / Display stack (Segoe UI Variable on Windows), display face with negative tracking on titles and numbers, tabular figures. |
| Motion | Damped springs via `linear()` easing (cubic-bezier fallback). Panels settle in, their parts rise in turn; orb pops when switched on and keeps breathing; stat numbers pop on change; capsule buttons lift and catch a light sweep on hover; segmented pill slides on a spring; switch knob springs and stretches while pressed. All off under `prefers-reduced-motion`. |
| Controls | iOS switches (44x27, master 52x31) red when on; capsule buttons; glossy red primary buttons; segmented control as a capsule with a sliding white pill; capsule select on settings. |
| Focus and contrast | 2 px `#d91f2b` focus ring (4.9:1); muted text `#56575f` (7:1 on white, 5:1 or more on the glass over the dark backdrop); red text `#c01a24` (6.1:1); header text on the backdrop has its own tokens. |
| Size | Popup unchanged at 630 x 472 (473 measured with the rounding, as before); `tests/test_popup_layout.py` passes in light, dark, Twitch and support-note states. |

Screenshots (2x, from `tools/store_shots.py` captures): `before-*.png` (old design) and
`after-*.png` (this one): popup light / dark, settings light / dark. The settings dark capture is the
tool's store variant (some brand-naming rows hidden), the same for before and after.
