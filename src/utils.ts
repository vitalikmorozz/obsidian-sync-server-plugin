/** Maximum content size in bytes (must match server Zod/Fastify/Socket.IO limits) */
export const MAX_CONTENT_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * Check if content exceeds the upload size limit.
 * Returns a human-readable size string if exceeded, or null if within limits.
 */
export function checkContentSize(content: string, path: string): string | null {
	const size = new TextEncoder().encode(content).byteLength;
	if (size > MAX_CONTENT_SIZE) {
		const sizeMB = (size / (1024 * 1024)).toFixed(1);
		return `${path} (${sizeMB} MB) exceeds the 10 MB upload limit`;
	}
	return null;
}

const BINARY_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"bmp",
	"webp",
	"ico",
	"svg",
	"tiff",
	"tif",
	"pdf",
	"doc",
	"docx",
	"xls",
	"xlsx",
	"ppt",
	"pptx",
	"odt",
	"ods",
	"odp",
	"zip",
	"rar",
	"7z",
	"tar",
	"gz",
	"bz2",
	"xz",
	"mp3",
	"wav",
	"ogg",
	"flac",
	"aac",
	"wma",
	"m4a",
	"mp4",
	"avi",
	"mkv",
	"mov",
	"wmv",
	"flv",
	"webm",
	"exe",
	"dll",
	"so",
	"dylib",
	"bin",
	"ttf",
	"otf",
	"woff",
	"woff2",
	"eot",
	"db",
	"sqlite",
	"sqlite3",
]);

/**
 * Check if a file path refers to a binary file (needs base64 encoding).
 * Returns true if the file should be read/written as binary with base64 encoding.
 */
export function isBinaryFile(path: string): boolean {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return BINARY_EXTENSIONS.has(ext);
}

/**
 * Compute SHA-256 hash of a string.
 * Used for both text content and base64-encoded binary content.
 */
export async function computeHash(content: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(content);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
	return `sha256:${hex}`;
}

/**
 * Encode an ArrayBuffer to a base64 string.
 */
export function encodeToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

/**
 * Decode a base64 string to an ArrayBuffer.
 */
export function decodeFromBase64(str: string): ArrayBuffer {
	const binary = atob(str);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}
