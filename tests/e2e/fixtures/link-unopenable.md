# Unopenable Link

Tandem renders this href live — `defaultValidate("report.docx")` is true, since
it carries no `/` and no `:` — but `.docx` is not in `INTERNAL_LINK_EXTS`, so
the click boundary refuses it. That gap is the point of the test.

See [the quarterly report](report.docx) for details.
