import re, sys, glob

files = glob.glob("tests/server/*.test.ts")
results = []

for fp in files:
    with open(fp, encoding="utf-8") as f:
        src = f.read()
    lines = src.split("\n")
    # find it( or test( calls - track brace depth to find body boundaries
    i = 0
    n = len(lines)
    # We'll do a char-based scan for robustness re: multi-line bodies
    text = src
    pos = 0
    pattern = re.compile(r'\b(it|test)(?:\.\w+)?\s*\(\s*(`[^`]*`|"[^"]*"|\'[^\']*\')')
    for m in pattern.finditer(text):
        start = m.end()
        title = m.group(2)
        # find the function body: look for the next '{' after start, within reasonable distance, then match braces
        brace_search_limit = text.find(')', start)
        # find first '{' after m.start() within next 300 chars (arrow fn or function)
        open_brace_idx = text.find('{', start, start+400)
        if open_brace_idx == -1:
            continue
        depth = 0
        j = open_brace_idx
        end_idx = None
        while j < len(text):
            c = text[j]
            if c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    end_idx = j
                    break
            j += 1
        if end_idx is None:
            continue
        body = text[open_brace_idx:end_idx+1]
        if 'expect(' not in body and 'expect.' not in body and 'assert' not in body:
            line_no = text[:m.start()].count("\n") + 1
            results.append((fp, line_no, title))

for r in results:
    print(f"{r[0]}:{r[1]}: {r[2]}")
print(f"TOTAL: {len(results)}")
