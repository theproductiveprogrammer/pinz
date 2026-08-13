# pinz new tab

Makes every new Chrome tab open https://pinz.charleslobo.com.

## Install (unpacked — not in the Web Store)

1. `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. **Load unpacked** → select this `chrome-tab-extension/` folder

Chrome may periodically nag about developer-mode extensions; that's the cost
of not publishing to the Web Store.

## Notes

- The redirect lives in `newtab.js` — MV3's CSP silently blocks inline
  `<script>` tags on extension pages, so it can't go in the HTML.
- The interim page's background matches pinz (light + dark) so a new tab
  doesn't flash white before the redirect lands.
