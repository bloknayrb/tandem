import { DEFAULT_MCP_PORT } from "../../shared/constants";

export const API_BASE = `http://localhost:${DEFAULT_MCP_PORT}/api`;

/** Encode an ArrayBuffer as base64 (safe for large files). */
export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Check if a filename is a binary format that needs base64 encoding. */
export function isBinaryFormat(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(".docx");
}

/** Read a File and return its content ready for the upload API. */
export async function readFileForUpload(file: File): Promise<string> {
  if (isBinaryFormat(file.name)) {
    const buf = await file.arrayBuffer();
    return arrayBufferToBase64(buf);
  }
  return file.text();
}
