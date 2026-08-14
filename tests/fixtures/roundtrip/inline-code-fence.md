A code span whose content contains a backtick run needs a fence longer than any
run inside it. The serializer escapes the inner backticks instead of lengthening
the fence, so the span ends early and the words on either side get glued
together.

Control, and this one is clean: `console.error(\` followed by prose.

The case that breaks: `x ?? ``y``` and text after it.
