Test cases for the AIDA browser calibrator.

Each `*.json` file is a single calibration case consumed by
`tools/generate_test_report.js`. The schema matches the GUI's "Copy test case
command" output so new cases can be appended by pasting that command into a
terminal.

Important conventions:

- `optpar` always starts with the optical model number.
- The remaining values are the model parameters used by the browser.
- `image` is resolved relative to `aida_js_calibrator/calibration_images/`.
- `matches` is optional and stores manually paired image/catalogue stars for
  later validation work.

Generate a report for one case or a small subset with a substring filter:

```sh
npm run report -- IMG-9953
npm run report -- 010095
node tools/generate_test_report.js 010880 ams0881
```

Filtered reports are written as `test-report/index-<filter>.html`. Running
without filters still writes the full `test-report/index.html`.
