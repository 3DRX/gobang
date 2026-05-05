export const BOARD_SIZE = 15;

export type Seat = "black" | "white";
export type Cell = Seat | null;
export type RoomStatus = "waiting" | "playing" | "finished";
export type MoveErrorCode =
	| "room_not_found"
	| "room_full"
	| "invalid_json"
	| "not_joined"
	| "not_your_turn"
	| "occupied"
	| "game_over"
	| "out_of_bounds";

export interface Player {
	seat: Seat;
	displayName: string;
	connected: boolean;
}

export interface StoredPlayer extends Player {
	clientId: string;
}

export interface Move {
	seat: Seat;
	x: number;
	y: number;
	at: string;
}

export interface PublicMove extends Move {
	index: number;
}

export interface WinningPoint {
	x: number;
	y: number;
}

export interface StoredGameState {
	roomId: string;
	status: RoomStatus;
	players: StoredPlayer[];
	board: Cell[][];
	turn: Seat;
	winner: Seat | null;
	winningLine: WinningPoint[];
	lastMove: Move | null;
	moves: Move[];
	moveCount: number;
	createdAt: string;
	updatedAt: string;
}

export interface GameState {
	roomId: string;
	status: RoomStatus;
	players: Player[];
	board: Cell[][];
	turn: Seat;
	winner: Seat | null;
	winningLine: WinningPoint[];
	lastMove: PublicMove | null;
	moveCount: number;
	createdAt: string;
	updatedAt: string;
}

export type MoveResult =
	| { ok: true; state: StoredGameState }
	| { ok: false; code: MoveErrorCode; message: string };

const DIRECTIONS = [
	[1, 0],
	[0, 1],
	[1, 1],
	[1, -1],
] as const;

export function createEmptyBoard(): Cell[][] {
	return Array.from({ length: BOARD_SIZE }, () => Array<Cell>(BOARD_SIZE).fill(null));
}

export function createInitialState(roomId: string, now = new Date().toISOString()): StoredGameState {
	return {
		roomId,
		status: "waiting",
		players: [],
		board: createEmptyBoard(),
		turn: "black",
		winner: null,
		winningLine: [],
		lastMove: null,
		moves: [],
		moveCount: 0,
		createdAt: now,
		updatedAt: now,
	};
}

export function toPublicState(state: StoredGameState): GameState {
	const lastMove = state.lastMove
		? {
				...state.lastMove,
				index: state.moveCount,
			}
		: null;

	return {
		roomId: state.roomId,
		status: state.status,
		players: state.players.map(({ seat, displayName, connected }) => ({
			seat,
			displayName,
			connected,
		})),
		board: state.board,
		turn: state.turn,
		winner: state.winner,
		winningLine: state.winningLine,
		lastMove,
		moveCount: state.moveCount,
		createdAt: state.createdAt,
		updatedAt: state.updatedAt,
	};
}

export function nextSeat(seat: Seat): Seat {
	return seat === "black" ? "white" : "black";
}

export function applyMove(
	state: StoredGameState,
	seat: Seat,
	x: number,
	y: number,
	now = new Date().toISOString(),
): MoveResult {
	if (state.winner) {
		return { ok: false, code: "game_over", message: "This game is already over." };
	}

	if (!Number.isInteger(x) || !Number.isInteger(y) || !isInBounds(x, y)) {
		return { ok: false, code: "out_of_bounds", message: "That move is outside the board." };
	}

	if (state.turn !== seat) {
		return { ok: false, code: "not_your_turn", message: "Wait for your turn." };
	}

	if (state.board[y]?.[x]) {
		return { ok: false, code: "occupied", message: "That intersection is already occupied." };
	}

	const board = cloneBoard(state.board);
	board[y][x] = seat;

	const winningLine = findWinningLine(board, seat, x, y);
	const move: Move = { seat, x, y, at: now };
	const winner = winningLine.length >= 5 ? seat : null;
	const moveCount = state.moveCount + 1;

	return {
		ok: true,
		state: {
			...state,
			status: winner ? "finished" : "playing",
			board,
			turn: winner ? state.turn : nextSeat(seat),
			winner,
			winningLine,
			lastMove: move,
			moves: [...state.moves, move],
			moveCount,
			updatedAt: now,
		},
	};
}

export function isInBounds(x: number, y: number): boolean {
	return x >= 0 && x < BOARD_SIZE && y >= 0 && y < BOARD_SIZE;
}

function cloneBoard(board: Cell[][]): Cell[][] {
	return board.map((row) => [...row]);
}

function findWinningLine(board: Cell[][], seat: Seat, x: number, y: number): WinningPoint[] {
	for (const [dx, dy] of DIRECTIONS) {
		const line = collectLine(board, seat, x, y, dx, dy);
		if (line.length >= 5) {
			return line;
		}
	}

	return [];
}

function collectLine(
	board: Cell[][],
	seat: Seat,
	x: number,
	y: number,
	dx: number,
	dy: number,
): WinningPoint[] {
	const before = collectDirection(board, seat, x, y, -dx, -dy).reverse();
	const after = collectDirection(board, seat, x, y, dx, dy);

	return [...before, { x, y }, ...after];
}

function collectDirection(
	board: Cell[][],
	seat: Seat,
	x: number,
	y: number,
	dx: number,
	dy: number,
): WinningPoint[] {
	const points: WinningPoint[] = [];
	let nextX = x + dx;
	let nextY = y + dy;

	while (isInBounds(nextX, nextY) && board[nextY][nextX] === seat) {
		points.push({ x: nextX, y: nextY });
		nextX += dx;
		nextY += dy;
	}

	return points;
}
