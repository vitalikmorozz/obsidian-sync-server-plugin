/**
 * Two-way text merge using LCS (Longest Common Subsequence) diffing.
 * Produces merged output with git-style conflict markers for true conflicts.
 */

export interface MergeResult {
	content: string;
	hasConflicts: boolean;
	conflictCount: number;
}

// ============================================================================
// LCS Computation
// ============================================================================

/**
 * Compute the Longest Common Subsequence of two string arrays.
 * Returns an array of [indexInA, indexInB] pairs representing matching lines.
 */
function computeLCS(a: string[], b: string[]): [number, number][] {
	const m = a.length;
	const n = b.length;

	// Build LCS length table
	const dp: number[][] = Array.from({ length: m + 1 }, () =>
		new Array(n + 1).fill(0),
	);

	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			if (a[i - 1] === b[j - 1]) {
				dp[i][j] = dp[i - 1][j - 1] + 1;
			} else {
				dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
			}
		}
	}

	// Backtrack to find the actual subsequence indices
	const pairs: [number, number][] = [];
	let i = m;
	let j = n;

	while (i > 0 && j > 0) {
		if (a[i - 1] === b[j - 1]) {
			pairs.push([i - 1, j - 1]);
			i--;
			j--;
		} else if (dp[i - 1][j] >= dp[i][j - 1]) {
			i--;
		} else {
			j--;
		}
	}

	pairs.reverse();
	return pairs;
}

// ============================================================================
// Merge
// ============================================================================

/**
 * Merge two versions of text content using LCS-based diffing.
 *
 * - Lines common to both versions are kept as-is.
 * - Lines added on only one side are included.
 * - Lines that conflict (both sides changed the same region) get conflict markers.
 *
 * @param localContent - The local file content
 * @param serverContent - The server file content
 * @returns MergeResult with merged content and conflict info
 */
export function mergeContents(
	localContent: string,
	serverContent: string,
): MergeResult {
	// Fast path: identical content
	if (localContent === serverContent) {
		return { content: localContent, hasConflicts: false, conflictCount: 0 };
	}

	const localLines = localContent.split("\n");
	const serverLines = serverContent.split("\n");

	const lcs = computeLCS(localLines, serverLines);

	const merged: string[] = [];
	let conflictCount = 0;

	let li = 0; // Current position in localLines
	let si = 0; // Current position in serverLines
	let lcsIdx = 0; // Current position in LCS pairs

	while (lcsIdx < lcs.length) {
		const [lcsLocal, lcsServer] = lcs[lcsIdx];

		// Collect lines before the next LCS match on each side
		const localBefore: string[] = [];
		const serverBefore: string[] = [];

		while (li < lcsLocal) {
			localBefore.push(localLines[li]);
			li++;
		}
		while (si < lcsServer) {
			serverBefore.push(serverLines[si]);
			si++;
		}

		// Merge the "before" sections
		if (localBefore.length > 0 || serverBefore.length > 0) {
			mergeRegions(localBefore, serverBefore, merged, () => {
				conflictCount++;
			});
		}

		// Emit the common LCS line
		merged.push(localLines[lcsLocal]);
		li = lcsLocal + 1;
		si = lcsServer + 1;
		lcsIdx++;
	}

	// Handle remaining lines after the last LCS match
	const localRemaining: string[] = [];
	const serverRemaining: string[] = [];

	while (li < localLines.length) {
		localRemaining.push(localLines[li]);
		li++;
	}
	while (si < serverLines.length) {
		serverRemaining.push(serverLines[si]);
		si++;
	}

	if (localRemaining.length > 0 || serverRemaining.length > 0) {
		mergeRegions(localRemaining, serverRemaining, merged, () => {
			conflictCount++;
		});
	}

	return {
		content: merged.join("\n"),
		hasConflicts: conflictCount > 0,
		conflictCount,
	};
}

/**
 * Merge two diverging regions of lines.
 *
 * - If only one side has lines, include them (non-conflicting addition).
 * - If both sides have the same lines, include them once.
 * - If both sides have different lines, emit a conflict block.
 */
function mergeRegions(
	localLines: string[],
	serverLines: string[],
	output: string[],
	onConflict: () => void,
): void {
	if (localLines.length === 0) {
		// Only server has additions
		output.push(...serverLines);
	} else if (serverLines.length === 0) {
		// Only local has additions
		output.push(...localLines);
	} else if (linesEqual(localLines, serverLines)) {
		// Both sides made the same change
		output.push(...localLines);
	} else {
		// True conflict — both sides changed differently
		onConflict();
		output.push("<<<<<<< LOCAL");
		output.push(...localLines);
		output.push("=======");
		output.push(...serverLines);
		output.push(">>>>>>> SERVER");
	}
}

/**
 * Check if two arrays of lines are identical.
 */
function linesEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}
