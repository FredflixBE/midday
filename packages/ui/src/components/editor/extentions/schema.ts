import { getSchema } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import StarterKit from "@tiptap/starter-kit";
import { DiagramNode } from "./diagram/node";
import { storedImage } from "./stored-image";
import { tableNodes } from "./table/node";

/**
 * What the editor writes, without what it looks like while writing it: the
 * text itself, its marks and links. `registerExtensions` starts from these.
 */
export const textExtensions = [
  StarterKit,
  Underline,
  Link.configure({
    openOnClick: false,
    autolink: true,
    defaultProtocol: "https",
  }),
];

/**
 * Every node and mark any editor built by `registerExtensions` can hold, and
 * nothing that needs a browser or React to be defined. A server reading or
 * writing a document the editor saved builds its schema from this (FF-1791),
 * so what it writes is what the editor would have written. The node views,
 * placeholder and menus the editor adds on top change how a document is
 * edited, never what it holds.
 */
export function schemaExtensions() {
  return [...textExtensions, storedImage(), ...tableNodes, DiagramNode];
}

export const editorSchema = getSchema(schemaExtensions());
