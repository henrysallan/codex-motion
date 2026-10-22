import type { BoardController } from './BoardController.ts';

// The open board, for app-level actions like paste.
export const boardRegistry: { current: BoardController | null } = { current: null };
