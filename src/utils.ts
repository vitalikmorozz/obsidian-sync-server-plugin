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

export function isBinaryFile(path: string): boolean {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return BINARY_EXTENSIONS.has(ext);
}

export async function computeHash(content: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(content);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
	return `sha256:${hex}`;
}
