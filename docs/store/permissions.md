# Privacy practices tab: answers

## Single purpose (one sentence)
> Ad Shield blocks unwanted content — ads, trackers, tracking cookies and cookie banners — on
> the web pages the user visits, including video ads on YouTube and Twitch.

(Everything in the extension serves that: rules, hiding CSS, the per-site switch, the element
picker, tracking-parameter removal and the filter-list updater. The donation link is incidental.
See `review-risks.md` risk 1 about "single purpose".)

## Permission justifications (paste one per box)

| Permission | Justification |
|---|---|
| `declarativeNetRequest` | Core function: static rulesets built from EasyList/EasyPrivacy block ad and tracker requests, strip third-party cookies, and remove tracking parameters; one dynamic rule implements the user's per-site allowlist and updated filter lists are installed as dynamic rules. |
| `declarativeNetRequestFeedback` | Used only to call `getMatchedRules` once when the popup opens, to show the user how many ads, trackers and cookie banners were blocked on the current tab, and for the toolbar badge count. No matches are logged or sent anywhere. |
| `scripting` | Registers and injects the extension's own bundled content: element-hiding CSS, the site-specific hiding injected per site, the user's own hiding filters, the element picker (only when the user clicks "Hide an element"), and the bundled page scripts that remove ad data on YouTube. No remote code is injected. |
| `storage` | Saves the user's settings, per-site allowlist, own filters, counters and the downloaded filter lists locally (`chrome.storage.local` / `session`). Nothing is synced or sent. |
| `unlimitedStorage` | The updated EasyList/EasyPrivacy/cookie-list rules and site-specific hiding data stored locally are several megabytes, above the default `storage.local` quota. |
| `alarms` | One weekly alarm that triggers the filter-list update (and a one-off check shortly after install/start). No alarm exists while "Update filter lists automatically" is off. |
| Host permission `<all_urls>` | Blocking, hiding and cookie rules must apply on every site the user visits; `modifyHeaders` rules (stripping third-party tracker cookies), content-script CSS registration, cookie-banner handling and `scripting` injection all need host access. The extension does not read, store or transmit page content. |
| Host permission `*://*.twitch.tv/*` | Twitch video-ad handling (page script and playlist processing run on twitch.tv). Technically already covered by `<all_urls>`; see `review-risks.md` risk 3: consider removing this line to shorten the review story. |

Not requested: `tabs`, `webRequest`, `webNavigation`, `cookies`, `history`, `proxy`, `activeTab`.
(Note: `chrome.tabs.create/query/reload/sendMessage` are used without the `tabs` permission; they
do not need it as no URL/title is read.)

## Remote code
**Select: "No, I am not using remote code."**

Basis (checked in the source): all JavaScript is in the package; no `<script src>` to external
hosts, no `eval`, `new Function`, `importScripts` of URLs, or code built from downloaded strings
(autoconsent is vendored, unmodified, and its "eval snippets" are functions bundled in the
package, run via `scripting.executeScript({func})`). The weekly update downloads **text filter
lists** which are parsed into declarative `declarativeNetRequest` rules and CSS selectors: data,
not code. If the reviewer asks, say so in one sentence: "The extension downloads only plain-text
filter lists (EasyList, EasyPrivacy, Fanboy Cookie List) and converts them to declarativeNetRequest
rules; no JavaScript is fetched or executed."

On Twitch the page script wraps Twitch's own worker script (read from twitch.tv) with the
extension's bundled worker code in a Blob worker. Twitch's code is the site's own; nothing is
loaded from the extension author's servers. Worth knowing in case of a question.

## Data usage checkboxes ("What user data do you collect?")
**Tick none of them**: Ad Shield does not collect any of: personally identifiable information,
health, financial and payment info, authentication information, personal communications,
location, web history, user activity, website content.

Reasoning on the two borderline ones: *Web history / Website content*: the extension processes
URLs and page elements locally to decide what to block, but does not collect (transmit or store
off-device) them. Google's definition of "collect" is transmitting data off the device, so none
is ticked. The per-site allowlist and counters stay on-device.

Then tick all three certifications:
- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

Privacy policy URL: the GitHub Pages address of `privacy-policy.html`.
