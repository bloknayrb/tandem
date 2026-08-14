Code spans and literal backticks in prose. Fence *style* (padding spaces, fence
length beyond the minimum) is invisible-tier and pinned separately — everything
here must come back byte-identical.

An ordinary span: `const x = 1` and prose after it.

A span ending in a backslash: `console.error(\` followed by prose.

A literal backtick keeps its escape: a lone \` in prose, and a \`\` pair on the
same line, because un-escaping either would make it a live delimiter.

A text run ending in a backtick, immediately before a real span: the escape is
what stops it merging with `the span's opening fence`.
