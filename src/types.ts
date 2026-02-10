export interface SyncServerSettings {
	url: string;
	apiKey: string;
}

export const DEFAULT_SETTINGS: SyncServerSettings = {
	url: "",
	apiKey: "",
};

export type AckResponse =
	| { success: true; hash?: string }
	| { success: false; error: { code: string; message: string } };

export interface FileCreatedEvent {
	path: string;
	content: string;
	hash: string;
	size: number;
	createdAt: string;
}

export interface FileModifiedEvent {
	path: string;
	content: string;
	hash: string;
	size: number;
	updatedAt: string;
}

export interface FileDeletedEvent {
	path: string;
	deletedAt: string;
}

export interface FileRenamedEvent {
	oldPath: string;
	newPath: string;
	content: string;
	hash: string;
	size: number;
	updatedAt: string;
}

export interface FileListResponse {
	files: Array<{
		path: string;
		hash: string;
		size: number;
		createdAt: string;
		updatedAt: string;
		expiresAt?: string; // Present when file is soft-deleted (tombstone)
	}>;
	total: number;
	limit: number;
	offset: number;
}

export interface FileContentResponse {
	path: string;
	content: string;
	hash: string;
	size: number;
	createdAt: string;
	updatedAt: string;
}
