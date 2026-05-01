import { Extension } from "@tiptap/core";

export const MarkdownHtmlExtension = Extension.create({
  name: "markdownHtml",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph"],
        attributes: {
          markdownHtml: {
            default: null,
            parseHTML: () => null,
            renderHTML: () => ({}),
          },
        },
      },
    ];
  },
});
