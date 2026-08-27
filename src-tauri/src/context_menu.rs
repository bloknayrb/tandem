//! Native editor context menus (#923).
//!
//! **Extracted from `lib.rs` (Unit 11b).** A pure move: the security contract
//! below, the fixed id set, the runtime OS branches and the window-scoped emit
//! are reproduced verbatim. The four items `lib.rs` still calls are
//! `pub(crate)` -- the three `#[tauri::command]`s named in `generate_handler!`
//! and `forward_context_menu_event` passed to `.on_menu_event(...)`. Their
//! three request structs are `pub(crate)` for the same reason and no other:
//! `#[tauri::command]` refuses to generate a wrapper whose argument type is
//! less visible than the command itself, so this is a widening the move
//! requires rather than one it chose. Everything else stays private to this
//! module -- `CtxItem`, `build_menu_from_spec`, all three spec builders,
//! `ContextMenuActionPayload` and `EVENT_CONTEXT_MENU_ACTION` -- and the test
//! modules are descendants, so they keep reaching those through `use super::*`
//! without widening anything. `mod context_menu;` is declared bare rather than `pub`, matching
//! `autostart.rs` and unlike `keychain.rs`.
//!
//! **`#[tauri::command]` names are not module-qualified**, so moving these
//! three does not touch the wire contract: the client still invokes
//! `"show_context_menu"`, `"show_tab_context_menu"` and
//! `"show_annotation_context_menu"` by bare name, and still listens for the
//! `"context-menu-action"` event.
//!
//! This cluster is the one in the Unit 11 epic with **no external guard test**
//! -- nothing in the repo reads `lib.rs` as text for a context-menu construct,
//! unlike the pending-update, native-theme, Cowork and startup clusters. That
//! is why `context_menu_id_space_tests` below exists: the `ctx:` prefix is what
//! separates these ids from the tray's `MENU_*` ids, and until now that
//! separation was convention with nothing asserting it -- convention that was
//! at least visible while both id spaces lived in one file, and is not
//! visible once they do not.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};

use crate::MAIN_WINDOW_LABEL;

// ---- Native editor context menu (issue #923) ------------------------------
//
// Security contract (enum-in / id-out): the request from JS carries only a kind
// enum + booleans — never an href or path. We build the menu from a FIXED id
// set and emit one of those ids back; the sensitive link href stays in the
// webview's module-local state and is re-validated there. The app-level
// `on_menu_event` (registered once in the builder) forwards `ctx:`-prefixed ids
// to the webview — see `EVENT_CONTEXT_MENU_ACTION`.

const EVENT_CONTEXT_MENU_ACTION: &str = "context-menu-action";

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
enum ContextMenuKind {
    EditorText,
    TableCell,
    Link,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContextMenuRequest {
    kind: ContextMenuKind,
    /// Gates the AI-selection intents and the enabled state of every
    /// selection-dependent item.
    has_selection: bool,
    is_editable: bool,
    #[allow(dead_code)] // overLink is implied by kind == Link
    over_link: bool,
    can_merge_cells: bool,
    can_split_cell: bool,
}

#[derive(serde::Serialize, Clone)]
struct ContextMenuActionPayload {
    id: String,
}

/// One item in a context menu. Predefined variants map to OS-native
/// `PredefinedMenuItem`s (Cut/Copy/Paste/Select All operate on the focused
/// webview); `Custom` items carry a `ctx:` id routed back to the editor.
#[derive(Debug, PartialEq, Eq)]
enum CtxItem {
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Separator,
    /// (id, label, enabled)
    Custom(&'static str, &'static str, bool),
    /// (id, label, enabled, native accelerator)
    Accelerated(&'static str, &'static str, bool, &'static str),
    /// Recursive group. Submenu ids are deliberately not routed leaves.
    Submenu(&'static str, Vec<CtxItem>),
}

fn selection_intents(req: &ContextMenuRequest) -> Vec<CtxItem> {
    let enabled = req.is_editable && req.has_selection;
    vec![
        CtxItem::Custom("ctx:selection:askAi", "Ask AI about selection…", enabled),
        CtxItem::Custom("ctx:selection:comment", "Comment to AI…", enabled),
        CtxItem::Custom("ctx:selection:privateNote", "Private Note…", enabled),
    ]
}

/// Pure builder — returns the item spec for a request. Unit-tested like
/// `reveal_command_args`; building the real `Menu` (which needs a manager) is a
/// thin mapping over this in `build_context_menu`.
fn build_context_menu_spec(req: &ContextMenuRequest) -> Vec<CtxItem> {
    let ed = req.is_editable;
    match req.kind {
        ContextMenuKind::Link => {
            let mut spec = vec![
                CtxItem::Custom("ctx:link:open", "Open Link", true),
                CtxItem::Custom("ctx:link:copy", "Copy Link", true),
                CtxItem::Custom("ctx:link:edit", "Edit Link…", ed),
                CtxItem::Custom("ctx:link:remove", "Remove Link", ed),
                CtxItem::Separator,
                CtxItem::Cut,
                CtxItem::Copy,
                CtxItem::Paste,
            ];
            if req.has_selection {
                spec.push(CtxItem::Separator);
                spec.extend(selection_intents(req));
            }
            spec
        }
        ContextMenuKind::TableCell => {
            let mut spec = vec![
                CtxItem::Cut,
                CtxItem::Copy,
                CtxItem::Paste,
                CtxItem::Separator,
                CtxItem::Submenu(
                    "Rows",
                    vec![
                        CtxItem::Custom("ctx:table:insertRowAbove", "Insert Above", ed),
                        CtxItem::Custom("ctx:table:insertRowBelow", "Insert Below", ed),
                        CtxItem::Separator,
                        CtxItem::Custom("ctx:table:deleteRow", "Delete Row", ed),
                    ],
                ),
                CtxItem::Submenu(
                    "Columns",
                    vec![
                        CtxItem::Custom("ctx:table:insertColLeft", "Insert Left", ed),
                        CtxItem::Custom("ctx:table:insertColRight", "Insert Right", ed),
                        CtxItem::Separator,
                        CtxItem::Custom("ctx:table:deleteCol", "Delete Column", ed),
                    ],
                ),
                CtxItem::Custom(
                    "ctx:table:mergeCells",
                    "Merge Cells",
                    ed && req.can_merge_cells,
                ),
                CtxItem::Custom(
                    "ctx:table:splitCell",
                    "Split Cell",
                    ed && req.can_split_cell,
                ),
                CtxItem::Separator,
                CtxItem::Custom("ctx:table:deleteTable", "Delete Table", ed),
            ];
            if req.has_selection {
                spec.push(CtxItem::Separator);
                spec.extend(selection_intents(req));
            }
            spec
        }
        ContextMenuKind::EditorText => {
            let mut spec = vec![
                CtxItem::Undo,
                CtxItem::Redo,
                CtxItem::Separator,
                CtxItem::Cut,
                CtxItem::Copy,
                CtxItem::Paste,
                CtxItem::Accelerated(
                    "ctx:pastePlain",
                    "Paste as Raw Text",
                    ed,
                    "CmdOrCtrl+Shift+V",
                ),
                CtxItem::Separator,
                CtxItem::SelectAll,
            ];
            if req.has_selection {
                spec.push(CtxItem::Separator);
                spec.extend(selection_intents(req));
            }
            spec
        }
    }
}

fn build_menu_items_from_spec(
    window: &tauri::WebviewWindow,
    spec: &[CtxItem],
) -> tauri::Result<Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>>> {
    use tauri::menu::IsMenuItem;
    let mut items: Vec<Box<dyn IsMenuItem<tauri::Wry>>> = Vec::with_capacity(spec.len());
    for item in spec {
        let boxed: Box<dyn IsMenuItem<tauri::Wry>> =
            match item {
                CtxItem::Undo => Box::new(PredefinedMenuItem::undo(window, None)?),
                CtxItem::Redo => Box::new(PredefinedMenuItem::redo(window, None)?),
                CtxItem::Cut => Box::new(PredefinedMenuItem::cut(window, None)?),
                CtxItem::Copy => Box::new(PredefinedMenuItem::copy(window, None)?),
                CtxItem::Paste => Box::new(PredefinedMenuItem::paste(window, None)?),
                CtxItem::SelectAll => Box::new(PredefinedMenuItem::select_all(window, None)?),
                CtxItem::Separator => Box::new(PredefinedMenuItem::separator(window)?),
                CtxItem::Custom(id, label, enabled) => Box::new(MenuItem::with_id(
                    window,
                    *id,
                    *label,
                    *enabled,
                    None::<&str>,
                )?),
                CtxItem::Accelerated(id, label, enabled, accelerator) => Box::new(
                    MenuItem::with_id(window, *id, *label, *enabled, Some(*accelerator))?,
                ),
                CtxItem::Submenu(label, children) => {
                    let child_items = build_menu_items_from_spec(window, children)?;
                    let child_refs: Vec<&dyn IsMenuItem<tauri::Wry>> =
                        child_items.iter().map(|item| item.as_ref()).collect();
                    Box::new(Submenu::with_items(window, *label, true, &child_refs)?)
                }
            };
        items.push(boxed);
    }
    Ok(items)
}

fn build_menu_from_spec(
    window: &tauri::WebviewWindow,
    spec: &[CtxItem],
) -> tauri::Result<Menu<tauri::Wry>> {
    use tauri::menu::IsMenuItem;
    let items = build_menu_items_from_spec(window, spec)?;
    let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = items.iter().map(|b| b.as_ref()).collect();
    Menu::with_items(window, &refs)
}

fn build_context_menu(
    window: &tauri::WebviewWindow,
    req: &ContextMenuRequest,
) -> tauri::Result<Menu<tauri::Wry>> {
    build_menu_from_spec(window, &build_context_menu_spec(req))
}

#[tauri::command]
pub(crate) fn show_context_menu(window: tauri::WebviewWindow, req: ContextMenuRequest) -> Result<(), String> {
    let menu = build_context_menu(&window, &req).map_err(|e| e.to_string())?;
    // Cursor-position overload; popup is modal so the local `menu` outlives the
    // user's click and can drop afterwards (no retention needed).
    window.popup_menu(&menu).map_err(|e| e.to_string())?;
    Ok(())
}

// ---- Tab-strip context menu (issue #923, Phase 2) -------------------------
//
// Reuses the Phase 1 plumbing: the same fixed-id / boolean-only request shape,
// the same `build_menu_from_spec` mapping, and the same app-level
// `forward_context_menu_event` (any `ctx:`-prefixed id is emitted back). Tab
// actions are all app-level (close tabs, copy path, reveal), so every item is a
// custom `ctx:tab:*` id routed to the webview — no PredefinedMenuItems.

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TabContextMenuRequest {
    /// At least one tab sits to the left of the clicked tab.
    can_close_left: bool,
    /// More than one tab is open → "Close Others" is meaningful.
    can_close_others: bool,
    /// At least one tab sits to the right of the clicked tab.
    can_close_right: bool,
    can_rename: bool,
    can_save: bool,
    /// Selects the fixed Save As label; no filename/path crosses IPC.
    save_as: bool,
    can_copy_file_name: bool,
    /// The tab maps to a real on-disk file (not a scratchpad / upload) →
    /// Copy Path + Reveal are meaningful.
    has_path: bool,
    can_toggle_source_view: bool,
    /// Selects the fixed return-to-editor label.
    source_view_active: bool,
}

/// OS-appropriate label for the reveal-in-file-manager item. Mirrors the
/// per-OS verb users expect (Finder / Explorer / generic).
fn reveal_in_file_manager_label(target_os: &str) -> &'static str {
    match target_os {
        "macos" => "Reveal in Finder",
        "windows" => "Show in File Explorer",
        _ => "Show in File Manager",
    }
}

fn build_tab_context_menu_spec(req: &TabContextMenuRequest, target_os: &str) -> Vec<CtxItem> {
    vec![
        CtxItem::Custom("ctx:tab:close", "Close", true),
        CtxItem::Custom(
            "ctx:tab:closeLeft",
            "Close Tabs to the Left",
            req.can_close_left,
        ),
        CtxItem::Custom("ctx:tab:closeOthers", "Close Others", req.can_close_others),
        CtxItem::Custom(
            "ctx:tab:closeRight",
            "Close to the Right",
            req.can_close_right,
        ),
        CtxItem::Separator,
        CtxItem::Custom("ctx:tab:rename", "Rename", req.can_rename),
        CtxItem::Custom(
            "ctx:tab:save",
            if req.save_as { "Save As…" } else { "Save" },
            req.can_save,
        ),
        CtxItem::Custom(
            "ctx:tab:toggleSourceView",
            if req.source_view_active {
                "Return to Formatted Editor"
            } else {
                "View Markdown Source"
            },
            req.can_toggle_source_view,
        ),
        CtxItem::Separator,
        CtxItem::Custom(
            "ctx:tab:copyFileName",
            "Copy File Name",
            req.can_copy_file_name,
        ),
        CtxItem::Custom("ctx:tab:copyPath", "Copy Path", req.has_path),
        CtxItem::Custom(
            "ctx:tab:reveal",
            reveal_in_file_manager_label(target_os),
            req.has_path,
        ),
    ]
}

#[tauri::command]
pub(crate) fn show_tab_context_menu(
    window: tauri::WebviewWindow,
    req: TabContextMenuRequest,
) -> Result<(), String> {
    let spec = build_tab_context_menu_spec(&req, std::env::consts::OS);
    let menu = build_menu_from_spec(&window, &spec).map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())?;
    Ok(())
}

// ---- Annotation-card context menu (issue #999, #923 Phase 3) ----------------
//
// Same plumbing as Phase 1/2: booleans-only request, fixed `ctx:annotation:*` ids routed
// back through the shared `forward_context_menu_event`, all custom items (no
// PredefinedMenuItems — "Copy text" is a custom webview clipboard write of the annotation
// body, not the native Copy of a selection). The sensitive annotation id never crosses
// IPC; only these booleans go in. Items are grouped and EMPTY GROUPS COLLAPSE their
// separators, so the menu never shows a leading/trailing/doubled divider.

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnnotationContextMenuRequest {
    can_accept: bool,
    can_dismiss: bool,
    can_reply: bool,
    can_edit: bool,
    can_send_to_claude: bool,
    can_copy: bool,
    can_remove: bool,
    /// Remove item label: note → "Archive", else → "Remove".
    is_note: bool,
}

fn build_annotation_context_menu_spec(req: &AnnotationContextMenuRequest) -> Vec<CtxItem> {
    // Four logical groups; an item is present only when its gate is true. Empty groups
    // are dropped and the surviving groups are joined with a single separator each.
    let review: Vec<CtxItem> = [
        (req.can_accept, "ctx:annotation:accept", "Accept"),
        (req.can_dismiss, "ctx:annotation:dismiss", "Dismiss"),
    ]
    .into_iter()
    .filter_map(|(on, id, label)| on.then_some(CtxItem::Custom(id, label, true)))
    .collect();

    let compose: Vec<CtxItem> = [
        (req.can_reply, "ctx:annotation:reply", "Reply…"),
        (req.can_edit, "ctx:annotation:edit", "Edit…"),
        (
            req.can_send_to_claude,
            "ctx:annotation:sendToClaude",
            "Send to Claude",
        ),
    ]
    .into_iter()
    .filter_map(|(on, id, label)| on.then_some(CtxItem::Custom(id, label, true)))
    .collect();

    let clipboard: Vec<CtxItem> = if req.can_copy {
        vec![CtxItem::Custom("ctx:annotation:copy", "Copy text", true)]
    } else {
        vec![]
    };

    let destructive: Vec<CtxItem> = if req.can_remove {
        let label = if req.is_note { "Archive" } else { "Remove" };
        vec![CtxItem::Custom("ctx:annotation:remove", label, true)]
    } else {
        vec![]
    };

    let mut out: Vec<CtxItem> = Vec::new();
    for group in [review, compose, clipboard, destructive] {
        if group.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(CtxItem::Separator);
        }
        out.extend(group);
    }
    out
}

#[tauri::command]
pub(crate) fn show_annotation_context_menu(
    window: tauri::WebviewWindow,
    req: AnnotationContextMenuRequest,
) -> Result<(), String> {
    let spec = build_annotation_context_menu_spec(&req);
    let menu = build_menu_from_spec(&window, &spec).map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())?;
    Ok(())
}

/// Whether a menu id belongs to this module's id space and should be forwarded
/// to the webview.
///
/// Split out of `forward_context_menu_event` so it can be tested at all: the
/// handler itself needs a live `AppHandle` and a `MenuEvent`, neither of which
/// a unit test can build, which is why the one rule separating these ids from
/// the tray's `MENU_*` ids had nothing asserting it. The handler is the only
/// caller; the split changes no behaviour.
fn is_forwardable_ctx_id(id: &str) -> bool {
    id.starts_with("ctx:")
}

/// App-level menu-event handler (registered ONCE in the builder). Forwards
/// `ctx:`-prefixed ids to the main webview; tray ids (`MENU_*`) are handled by
/// the tray's own scoped handler and ignored here. Window-scoped emit so a
/// future second window can't receive another window's action.
pub(crate) fn forward_context_menu_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    let id = event.id().as_ref();
    if !is_forwardable_ctx_id(id) {
        return;
    }
    // Window-scoped on purpose: a future second window must not receive
    // another window's action. **Nothing tests this**, and flattening it to
    // `app.emit(...)` is green everywhere -- confirmed by mutation, and it is
    // the one survivor in Unit 11b's battery. Reaching it needs a live
    // `AppHandle` and a second window, which no unit test can build and which
    // only a `tests/tauri-driver/` WebDriver spec could. Left as prose with
    // its limitation stated rather than covered by a source-text assertion
    // that would read stronger than it is.
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        if let Err(e) = window.emit(
            EVENT_CONTEXT_MENU_ACTION,
            ContextMenuActionPayload { id: id.to_string() },
        ) {
            log::warn!("Failed to emit context-menu action {id}: {e}");
        }
    }
}

/// Unit tests for the pure context-menu spec builder (#923). The real `Menu`
/// needs a Tauri manager and can't be built in a unit test, so we assert the
/// item spec instead — the part that decides which ids/labels/enabled-states
/// each context produces.
#[cfg(test)]
mod context_menu_tests {
    use super::*;

    fn req(kind: ContextMenuKind, is_editable: bool) -> ContextMenuRequest {
        ContextMenuRequest {
            kind,
            has_selection: false,
            is_editable,
            over_link: false,
            can_merge_cells: false,
            can_split_cell: false,
        }
    }

    fn custom_ids(spec: &[CtxItem]) -> Vec<&'static str> {
        let mut ids = Vec::new();
        for item in spec {
            match item {
                CtxItem::Custom(id, _, _) | CtxItem::Accelerated(id, _, _, _) => ids.push(*id),
                CtxItem::Submenu(_, children) => ids.extend(custom_ids(children)),
                _ => {}
            }
        }
        ids
    }

    fn enabled_of(spec: &[CtxItem], id: &str) -> Option<bool> {
        spec.iter().find_map(|i| match i {
            CtxItem::Custom(item_id, _, enabled) | CtxItem::Accelerated(item_id, _, enabled, _)
                if *item_id == id =>
            {
                Some(*enabled)
            }
            CtxItem::Submenu(_, children) => enabled_of(children, id),
            _ => None,
        })
    }

    #[test]
    fn link_menu_has_open_copy_remove_then_clipboard() {
        let spec = build_context_menu_spec(&req(ContextMenuKind::Link, true));
        assert_eq!(
            custom_ids(&spec),
            vec![
                "ctx:link:open",
                "ctx:link:copy",
                "ctx:link:edit",
                "ctx:link:remove"
            ]
        );
        // Native clipboard items follow.
        assert!(spec.contains(&CtxItem::Cut));
        assert!(spec.contains(&CtxItem::Paste));
    }

    #[test]
    fn table_menu_lists_all_structural_ops() {
        let spec = build_context_menu_spec(&req(ContextMenuKind::TableCell, true));
        for id in [
            "ctx:table:insertRowAbove",
            "ctx:table:insertRowBelow",
            "ctx:table:insertColLeft",
            "ctx:table:insertColRight",
            "ctx:table:deleteRow",
            "ctx:table:deleteCol",
            "ctx:table:mergeCells",
            "ctx:table:splitCell",
            "ctx:table:deleteTable",
        ] {
            assert!(custom_ids(&spec).contains(&id), "table menu missing {id}");
        }
        // Cells get clipboard too (right-click in a cell is still editable text).
        assert!(spec.contains(&CtxItem::Cut));
    }

    #[test]
    fn merge_and_split_gated_on_can_flags() {
        let mut r = req(ContextMenuKind::TableCell, true);
        r.can_merge_cells = true; // split stays false
        let spec = build_context_menu_spec(&r);
        assert_eq!(enabled_of(&spec, "ctx:table:mergeCells"), Some(true));
        assert_eq!(enabled_of(&spec, "ctx:table:splitCell"), Some(false));
    }

    #[test]
    fn editor_text_menu_has_undo_clipboard_paste_plain_select_all() {
        let spec = build_context_menu_spec(&req(ContextMenuKind::EditorText, true));
        assert_eq!(custom_ids(&spec), vec!["ctx:pastePlain"]);
        assert!(spec.contains(&CtxItem::Undo));
        assert!(spec.contains(&CtxItem::Redo));
        assert!(spec.contains(&CtxItem::SelectAll));
        assert!(spec.contains(&CtxItem::Paste));
        assert!(spec.contains(&CtxItem::Accelerated(
            "ctx:pastePlain",
            "Paste as Raw Text",
            true,
            "CmdOrCtrl+Shift+V",
        )));
    }

    #[test]
    fn selection_intents_are_present_only_for_a_non_empty_selection() {
        let mut r = req(ContextMenuKind::EditorText, true);
        assert!(!custom_ids(&build_context_menu_spec(&r)).contains(&"ctx:selection:askAi"));
        r.has_selection = true;
        let ids = custom_ids(&build_context_menu_spec(&r));
        assert!(ids.contains(&"ctx:selection:askAi"));
        assert!(ids.contains(&"ctx:selection:comment"));
        assert!(ids.contains(&"ctx:selection:privateNote"));
    }

    #[test]
    fn table_rows_and_columns_are_recursive_submenus() {
        let spec = build_context_menu_spec(&req(ContextMenuKind::TableCell, true));
        assert!(matches!(&spec[4], CtxItem::Submenu("Rows", _)));
        assert!(matches!(&spec[5], CtxItem::Submenu("Columns", _)));
    }

    #[test]
    fn read_only_disables_mutating_items_but_keeps_navigation() {
        // Read-only doc: table mutations + paste-plain are disabled;
        // Open/Copy Link stay enabled (they don't mutate the document).
        let table = build_context_menu_spec(&req(ContextMenuKind::TableCell, false));
        assert_eq!(enabled_of(&table, "ctx:table:deleteRow"), Some(false));
        assert_eq!(enabled_of(&table, "ctx:table:deleteTable"), Some(false));

        let text = build_context_menu_spec(&req(ContextMenuKind::EditorText, false));
        assert_eq!(enabled_of(&text, "ctx:pastePlain"), Some(false));

        let link = build_context_menu_spec(&req(ContextMenuKind::Link, false));
        assert_eq!(enabled_of(&link, "ctx:link:open"), Some(true));
        assert_eq!(enabled_of(&link, "ctx:link:copy"), Some(true));
        assert_eq!(enabled_of(&link, "ctx:link:remove"), Some(false));
    }

    #[test]
    fn kind_deserializes_from_camel_case() {
        // The JS side sends camelCase kind strings; serde must accept them.
        let r: ContextMenuRequest = serde_json::from_value(serde_json::json!({
            "kind": "tableCell",
            "hasSelection": true,
            "isEditable": true,
            "overLink": false,
            "canMergeCells": true,
            "canSplitCell": false,
        }))
        .expect("camelCase request should deserialize");
        assert!(matches!(r.kind, ContextMenuKind::TableCell));
        assert!(r.can_merge_cells);
    }
}

/// Unit tests for the Phase 2 tab-strip context-menu spec builder (#923).
#[cfg(test)]
mod tab_context_menu_tests {
    use super::*;

    fn req(can_close_others: bool, can_close_right: bool, has_path: bool) -> TabContextMenuRequest {
        TabContextMenuRequest {
            can_close_left: false,
            can_close_others,
            can_close_right,
            can_rename: true,
            can_save: true,
            save_as: false,
            can_copy_file_name: true,
            has_path,
            can_toggle_source_view: true,
            source_view_active: false,
        }
    }

    fn enabled_of(spec: &[CtxItem], id: &str) -> Option<bool> {
        spec.iter().find_map(|i| match i {
            CtxItem::Custom(item_id, _, enabled) if *item_id == id => Some(*enabled),
            _ => None,
        })
    }

    #[test]
    fn lists_all_actions_in_order() {
        let spec = build_tab_context_menu_spec(&req(true, true, true), "linux");
        let ids: Vec<&str> = spec
            .iter()
            .filter_map(|i| match i {
                CtxItem::Custom(id, _, _) => Some(*id),
                _ => None,
            })
            .collect();
        assert_eq!(
            ids,
            vec![
                "ctx:tab:close",
                "ctx:tab:closeLeft",
                "ctx:tab:closeOthers",
                "ctx:tab:closeRight",
                "ctx:tab:rename",
                "ctx:tab:save",
                "ctx:tab:toggleSourceView",
                "ctx:tab:copyFileName",
                "ctx:tab:copyPath",
                "ctx:tab:reveal",
            ]
        );
    }

    #[test]
    fn close_is_always_enabled() {
        // Even a lone scratchpad tab can be closed.
        let spec = build_tab_context_menu_spec(&req(false, false, false), "linux");
        assert_eq!(enabled_of(&spec, "ctx:tab:close"), Some(true));
    }

    #[test]
    fn close_others_and_right_gate_on_their_flags() {
        let spec = build_tab_context_menu_spec(&req(false, false, true), "linux");
        assert_eq!(enabled_of(&spec, "ctx:tab:closeOthers"), Some(false));
        assert_eq!(enabled_of(&spec, "ctx:tab:closeRight"), Some(false));

        let spec = build_tab_context_menu_spec(&req(true, true, true), "linux");
        assert_eq!(enabled_of(&spec, "ctx:tab:closeOthers"), Some(true));
        assert_eq!(enabled_of(&spec, "ctx:tab:closeRight"), Some(true));
    }

    #[test]
    fn path_actions_gate_on_has_path() {
        // Scratchpad / upload tab → no real path → Copy Path + Reveal disabled.
        let spec = build_tab_context_menu_spec(&req(true, true, false), "macos");
        assert_eq!(enabled_of(&spec, "ctx:tab:copyPath"), Some(false));
        assert_eq!(enabled_of(&spec, "ctx:tab:reveal"), Some(false));
    }

    #[test]
    fn reveal_label_is_os_specific() {
        assert_eq!(reveal_in_file_manager_label("macos"), "Reveal in Finder");
        assert_eq!(reveal_in_file_manager_label("windows"), "Show in File Explorer");
        assert_eq!(reveal_in_file_manager_label("linux"), "Show in File Manager");
        assert_eq!(reveal_in_file_manager_label("freebsd"), "Show in File Manager");
    }

    #[test]
    fn request_deserializes_from_camel_case() {
        let r: TabContextMenuRequest = serde_json::from_value(serde_json::json!({
            "canCloseOthers": true,
            "canCloseLeft": false,
            "canCloseRight": false,
            "canRename": true,
            "canSave": true,
            "saveAs": false,
            "canCopyFileName": true,
            "hasPath": true,
            "canToggleSourceView": true,
            "sourceViewActive": false,
        }))
        .expect("camelCase tab request should deserialize");
        assert!(r.can_close_others);
        assert!(!r.can_close_right);
        assert!(r.has_path);
    }
}

/// Unit tests for the Phase 3 annotation-card context-menu spec builder (#999).
#[cfg(test)]
mod annotation_context_menu_tests {
    use super::*;

    /// All-off baseline; flip the fields a test cares about.
    fn none() -> AnnotationContextMenuRequest {
        AnnotationContextMenuRequest {
            can_accept: false,
            can_dismiss: false,
            can_reply: false,
            can_edit: false,
            can_send_to_claude: false,
            can_copy: false,
            can_remove: false,
            is_note: false,
        }
    }

    fn ids(spec: &[CtxItem]) -> Vec<&str> {
        spec.iter()
            .filter_map(|i| match i {
                CtxItem::Custom(id, _, _) => Some(*id),
                _ => None,
            })
            .collect()
    }

    fn label_of<'a>(spec: &'a [CtxItem], id: &str) -> Option<&'a str> {
        spec.iter().find_map(|i| match i {
            CtxItem::Custom(item_id, label, _) if *item_id == id => Some(*label),
            _ => None,
        })
    }

    /// Separators never lead, trail, or double up — the empty-group collapse contract.
    fn separators_well_formed(spec: &[CtxItem]) -> bool {
        if spec.is_empty() {
            return true;
        }
        if matches!(spec.first(), Some(CtxItem::Separator))
            || matches!(spec.last(), Some(CtxItem::Separator))
        {
            return false;
        }
        !spec
            .windows(2)
            .any(|w| matches!(w[0], CtxItem::Separator) && matches!(w[1], CtxItem::Separator))
    }

    #[test]
    fn user_note_shows_compose_copy_archive() {
        // author=user, type=note, pending → Reply…/Edit…/Send to Claude · Copy · Archive.
        let mut r = none();
        r.can_reply = true;
        r.can_edit = true;
        r.can_send_to_claude = true;
        r.can_copy = true;
        r.can_remove = true;
        r.is_note = true;
        let spec = build_annotation_context_menu_spec(&r);
        assert_eq!(
            ids(&spec),
            vec![
                "ctx:annotation:reply",
                "ctx:annotation:edit",
                "ctx:annotation:sendToClaude",
                "ctx:annotation:copy",
                "ctx:annotation:remove",
            ]
        );
        assert_eq!(label_of(&spec, "ctx:annotation:remove"), Some("Archive"));
        assert!(separators_well_formed(&spec));
        // Exactly two separators (compose|clipboard, clipboard|destructive).
        assert_eq!(
            spec.iter()
                .filter(|i| matches!(i, CtxItem::Separator))
                .count(),
            2
        );
    }

    #[test]
    fn claude_comment_shows_review_reply_copy() {
        // author=claude, type=comment, pending → Accept/Dismiss · Reply… · Copy.
        let mut r = none();
        r.can_accept = true;
        r.can_dismiss = true;
        r.can_reply = true;
        r.can_copy = true;
        let spec = build_annotation_context_menu_spec(&r);
        assert_eq!(
            ids(&spec),
            vec![
                "ctx:annotation:accept",
                "ctx:annotation:dismiss",
                "ctx:annotation:reply",
                "ctx:annotation:copy",
            ]
        );
        // No Edit (author != user), no Remove/Send.
        assert!(label_of(&spec, "ctx:annotation:edit").is_none());
        assert!(separators_well_formed(&spec));
    }

    #[test]
    fn user_highlight_remove_label_and_no_reply() {
        // author=user, type=highlight, pending → Edit… · Copy · Remove (not Archive); no Reply.
        let mut r = none();
        r.can_edit = true;
        r.can_copy = true;
        r.can_remove = true;
        r.is_note = false;
        let spec = build_annotation_context_menu_spec(&r);
        assert_eq!(
            ids(&spec),
            vec![
                "ctx:annotation:edit",
                "ctx:annotation:copy",
                "ctx:annotation:remove",
            ]
        );
        assert_eq!(label_of(&spec, "ctx:annotation:remove"), Some("Remove"));
        assert!(label_of(&spec, "ctx:annotation:reply").is_none());
        assert!(separators_well_formed(&spec));
    }

    #[test]
    fn resolved_annotation_shows_only_copy_no_separators() {
        // Every gate off except copy → a single item, no leading/trailing separator.
        let mut r = none();
        r.can_copy = true;
        let spec = build_annotation_context_menu_spec(&r);
        assert_eq!(ids(&spec), vec!["ctx:annotation:copy"]);
        assert!(separators_well_formed(&spec));
        assert_eq!(
            spec.iter()
                .filter(|i| matches!(i, CtxItem::Separator))
                .count(),
            0
        );
    }

    #[test]
    fn all_off_is_empty() {
        let spec = build_annotation_context_menu_spec(&none());
        assert!(spec.is_empty());
        assert!(separators_well_formed(&spec));
    }

    #[test]
    fn review_and_destructive_only_collapses_middle_groups() {
        // Accept/Dismiss + Remove, nothing in compose/clipboard → exactly one separator
        // between the two surviving groups (middle empty groups don't emit dividers).
        let mut r = none();
        r.can_accept = true;
        r.can_dismiss = true;
        r.can_remove = true;
        let spec = build_annotation_context_menu_spec(&r);
        assert_eq!(
            ids(&spec),
            vec![
                "ctx:annotation:accept",
                "ctx:annotation:dismiss",
                "ctx:annotation:remove",
            ]
        );
        assert!(separators_well_formed(&spec));
        assert_eq!(
            spec.iter()
                .filter(|i| matches!(i, CtxItem::Separator))
                .count(),
            1
        );
    }

    #[test]
    fn request_deserializes_from_camel_case() {
        let r: AnnotationContextMenuRequest = serde_json::from_value(serde_json::json!({
            "canAccept": false,
            "canDismiss": false,
            "canReply": true,
            "canEdit": true,
            "canSendToClaude": true,
            "canCopy": true,
            "canRemove": true,
            "isNote": true,
        }))
        .expect("camelCase annotation request should deserialize");
        assert!(r.can_reply);
        assert!(r.can_edit);
        assert!(r.can_send_to_claude);
        assert!(r.is_note);
        assert!(!r.can_accept);
    }
}

/// The `ctx:` prefix is the whole separation between these ids and the tray's
/// `MENU_*` ids, and `forward_context_menu_event` is the only thing that reads
/// it: an id without the prefix is dropped, an id with it is forwarded to the
/// webview. Nothing asserted either half before Unit 11b.
///
/// That mattered less while both id spaces were declared in one file, where a
/// collision was at least visible to a reader scrolling past. After the
/// extraction they are in two files that never appear on screen together, so
/// the invariant needs a test rather than a sight-line. Both directions are
/// pinned, because either one alone passes for the wrong reason: a tray id
/// gaining a `ctx:` prefix would be silently forwarded to the webview, and a
/// context-menu id losing it would be silently dropped -- a menu item that
/// does nothing when clicked, with no error anywhere.
#[cfg(test)]
mod context_menu_id_space_tests {
    use super::*;

    /// Every custom id any builder can emit, across every input combination
    /// the request types allow. Derived by running the builders, never from a
    /// list written here -- a list would only confirm the ids someone
    /// remembered to add.
    fn all_custom_ids() -> Vec<&'static str> {
        let mut ids = Vec::new();

        fn walk(spec: &[CtxItem], out: &mut Vec<&'static str>) {
            for item in spec {
                match item {
                    CtxItem::Custom(id, _, _) | CtxItem::Accelerated(id, _, _, _) => out.push(*id),
                    CtxItem::Submenu(_, children) => walk(children, out),
                    _ => {}
                }
            }
        }

        // Every field of all three request types is a bool (plus one 3-variant
        // enum), so the input space is small enough to enumerate exhaustively
        // rather than sample. `ContextMenuKind` is not `Copy`, hence the
        // rebuild per iteration.
        for k in 0..3u8 {
            for flags in 0u8..32 {
                let kind = match k {
                    0 => ContextMenuKind::EditorText,
                    1 => ContextMenuKind::Link,
                    _ => ContextMenuKind::TableCell,
                };
                walk(
                    &build_context_menu_spec(&ContextMenuRequest {
                        kind,
                        has_selection: flags & 1 != 0,
                        is_editable: flags & 2 != 0,
                        over_link: flags & 4 != 0,
                        can_merge_cells: flags & 8 != 0,
                        can_split_cell: flags & 16 != 0,
                    }),
                    &mut ids,
                );
            }
        }

        for target_os in ["macos", "windows", "linux"] {
            for flags in 0u16..1024 {
                walk(
                    &build_tab_context_menu_spec(
                        &TabContextMenuRequest {
                            can_close_left: flags & 1 != 0,
                            can_close_others: flags & 2 != 0,
                            can_close_right: flags & 4 != 0,
                            can_rename: flags & 8 != 0,
                            can_save: flags & 16 != 0,
                            save_as: flags & 32 != 0,
                            can_copy_file_name: flags & 64 != 0,
                            has_path: flags & 128 != 0,
                            can_toggle_source_view: flags & 256 != 0,
                            source_view_active: flags & 512 != 0,
                        },
                        target_os,
                    ),
                    &mut ids,
                );
            }
        }

        for flags in 0u16..256 {
            walk(
                &build_annotation_context_menu_spec(&AnnotationContextMenuRequest {
                    can_accept: flags & 1 != 0,
                    can_dismiss: flags & 2 != 0,
                    can_reply: flags & 4 != 0,
                    can_edit: flags & 8 != 0,
                    can_send_to_claude: flags & 16 != 0,
                    can_copy: flags & 32 != 0,
                    can_remove: flags & 64 != 0,
                    is_note: flags & 128 != 0,
                }),
                &mut ids,
            );
        }

        ids.sort_unstable();
        ids.dedup();
        ids
    }

    #[test]
    fn the_derivation_actually_finds_ids() {
        // The control. Every assertion below is a for-loop over this vector,
        // so an empty one satisfies all of them: zero ids is zero bad ids.
        let ids = all_custom_ids();
        assert!(
            ids.len() > 20,
            "the id sweep found only {} ids, so the checks below prove nothing",
            ids.len()
        );
        assert!(ids.contains(&"ctx:link:open"));
        assert!(ids.contains(&"ctx:tab:reveal"));
        // A submenu-nested id, deliberately. Without one, deleting the
        // recursive `CtxItem::Submenu` arm from `walk` still leaves well over
        // twenty ids and every assertion below passes over a set that silently
        // stopped containing the table operations -- found by mutation.
        assert!(
            ids.contains(&"ctx:table:insertRowAbove"),
            "the sweep found no submenu-nested id, so it is not walking submenus"
        );
    }

    #[test]
    fn the_forwarding_predicate_accepts_only_this_module_s_ids() {
        for id in all_custom_ids() {
            assert!(
                is_forwardable_ctx_id(id),
                "`{id}` is emitted by a builder but the handler would drop it"
            );
        }
        for id in [
            crate::MENU_OPEN,
            crate::MENU_SETUP,
            crate::MENU_ABOUT,
            crate::MENU_QUIT,
            crate::MENU_UPDATE,
        ] {
            assert!(
                !is_forwardable_ctx_id(id),
                "tray id `{id}` would be forwarded into the webview"
            );
        }
        assert!(!is_forwardable_ctx_id(""));
        assert!(!is_forwardable_ctx_id("ctx"));
        assert!(is_forwardable_ctx_id("ctx:"));
    }

    #[test]
    fn every_context_menu_id_carries_the_forwarding_prefix() {
        for id in all_custom_ids() {
            assert!(
                id.starts_with("ctx:"),
                "`{id}` is emitted by a context-menu builder but does not start with `ctx:`, \
                 so `forward_context_menu_event` drops it and clicking that item does nothing"
            );
        }
    }

    #[test]
    fn no_tray_id_could_be_mistaken_for_a_context_menu_id() {
        // The other direction. A tray id starting with `ctx:` would be
        // forwarded into the webview by the app-level handler as though a
        // context-menu item had been clicked.
        for id in [
            crate::MENU_OPEN,
            crate::MENU_SETUP,
            crate::MENU_ABOUT,
            crate::MENU_QUIT,
            crate::MENU_UPDATE,
        ] {
            assert!(
                !id.starts_with("ctx:"),
                "tray id `{id}` collides with the context-menu id space"
            );
        }
    }
}
