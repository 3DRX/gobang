import { DurableObject } from "cloudflare:workers";
import {
	applyMove,
	createInitialState,
	getRoomExpirationAt,
	shouldDeleteRoom,
	type GameState,
	type MoveErrorCode,
	type Seat,
	type StoredGameState,
	toPublicState,
} from "./game";

interface RoomRow {
	[key: string]: SqlStorageValue;
	id: string;
	state: string;
	created_at: string;
	updated_at: string;
}

interface SocketAttachment {
	clientId?: string;
	seat?: Seat;
}

type ClientMessage =
	| { type: "join"; clientId: string; displayName: string }
	| { type: "placeStone"; x: number; y: number };

type ServerMessage =
	| { type: "snapshot"; state: GameState; you?: { seat: Seat } }
	| { type: "error"; code: MoveErrorCode; message: string };

const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const ROOM_ROW_ID = "room";

// Kept only to preserve the scaffold's historical migration entry.
export class MyDurableObject extends DurableObject<Env> {}

export class GameRoom extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS rooms (
					id TEXT PRIMARY KEY,
					state TEXT NOT NULL,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				)
			`);
		});
	}

	initialize(roomId: string): GameState {
		const existing = this.loadState();
		if (existing) {
			return toPublicState(existing);
		}

		const state = createInitialState(roomId);
		this.saveState(state);
		this.scheduleCleanup(state);
		return toPublicState(state);
	}

	snapshot(): GameState | null {
		const state = this.loadState();
		return state ? toPublicState(state) : null;
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return jsonError("not_joined", "Expected a WebSocket upgrade request.", 426);
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		server.serializeAttachment({});
		this.ctx.acceptWebSocket(server);

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const parsed = parseClientMessage(message);
		if (!parsed.ok) {
			send(ws, { type: "error", code: "invalid_json", message: parsed.message });
			return;
		}

		if (parsed.message.type === "join") {
			this.handleJoin(ws, parsed.message);
			return;
		}

		this.handleMove(ws, parsed.message.x, parsed.message.y);
	}

	async webSocketClose(ws: WebSocket): Promise<void> {
		const attachment = getAttachment(ws);
		if (!attachment.clientId) {
			return;
		}

		const hasAnotherSocket = this.ctx.getWebSockets().some((socket) => {
			if (socket === ws) {
				return false;
			}
			const other = getAttachment(socket);
			return other.clientId === attachment.clientId;
		});

		if (!hasAnotherSocket) {
			this.updatePlayerConnection(attachment.clientId, false);
			this.broadcastSnapshot();
		}
	}

	async alarm(): Promise<void> {
		const state = this.loadState();
		if (!state) {
			await this.ctx.storage.deleteAlarm();
			return;
		}

		if (!shouldDeleteRoom(state)) {
			this.scheduleCleanup(state);
			return;
		}

		for (const socket of this.ctx.getWebSockets()) {
			send(socket, {
				type: "error",
				code: "room_not_found",
				message: "This room has expired.",
			});
			socket.close(1000, "room_expired");
		}

		this.deleteState();
		await this.ctx.storage.deleteAlarm();
	}

	private handleJoin(ws: WebSocket, message: Extract<ClientMessage, { type: "join" }>): void {
		const state = this.loadState();
		if (!state) {
			send(ws, { type: "error", code: "room_not_found", message: "This room does not exist." });
			ws.close(1008, "room_not_found");
			return;
		}

		const clientId = message.clientId.trim();
		if (!clientId) {
			send(ws, { type: "error", code: "not_joined", message: "A client id is required." });
			return;
		}

		const displayName = normalizeDisplayName(message.displayName);
		let nextState = state;
		let player = nextState.players.find((candidate) => candidate.clientId === clientId);

		if (!player) {
			if (nextState.players.length >= 2) {
				send(ws, { type: "error", code: "room_full", message: "This room already has two players." });
				ws.close(1008, "room_full");
				return;
			}

			player = {
				clientId,
				displayName,
				seat: nextState.players.some((candidate) => candidate.seat === "black") ? "white" : "black",
				connected: true,
			};
			nextState = {
				...nextState,
				players: [...nextState.players, player],
			};
		} else {
			nextState = {
				...nextState,
				players: nextState.players.map((candidate) =>
					candidate.clientId === clientId
						? {
								...candidate,
								displayName,
								connected: true,
							}
						: candidate,
				),
			};
			player = nextState.players.find((candidate) => candidate.clientId === clientId);
		}

		if (!player) {
			send(ws, { type: "error", code: "not_joined", message: "Unable to join the room." });
			return;
		}

		nextState = updateStatusForPlayers({
			...nextState,
			updatedAt: new Date().toISOString(),
		});
		this.saveState(nextState);
		this.scheduleCleanup(nextState);
		ws.serializeAttachment({ clientId, seat: player.seat });
		this.broadcastSnapshot();
	}

	private handleMove(ws: WebSocket, x: number, y: number): void {
		const attachment = getAttachment(ws);
		if (!attachment.clientId || !attachment.seat) {
			send(ws, { type: "error", code: "not_joined", message: "Join the room before playing." });
			return;
		}

		const state = this.loadState();
		if (!state) {
			send(ws, { type: "error", code: "room_not_found", message: "This room does not exist." });
			return;
		}

		if (!state.players.some((player) => player.clientId === attachment.clientId)) {
			send(ws, { type: "error", code: "not_joined", message: "You are not a player in this room." });
			return;
		}

		if (state.players.length < 2 || state.status === "waiting") {
			send(ws, { type: "error", code: "not_joined", message: "Wait for an opponent before playing." });
			return;
		}

		const result = applyMove(state, attachment.seat, x, y);
		if (!result.ok) {
			send(ws, { type: "error", code: result.code, message: result.message });
			return;
		}

		this.saveState(result.state);
		this.scheduleCleanup(result.state);
		this.broadcastSnapshot();
	}

	private broadcastSnapshot(): void {
		const state = this.loadState();
		if (!state) {
			return;
		}

		const publicState = toPublicState(state);
		for (const socket of this.ctx.getWebSockets()) {
			const attachment = getAttachment(socket);
			if (!attachment.seat) {
				continue;
			}
			send(socket, {
				type: "snapshot",
				state: publicState,
				you: { seat: attachment.seat },
			});
		}
	}

	private updatePlayerConnection(clientId: string, connected: boolean): void {
		const state = this.loadState();
		if (!state) {
			return;
		}

		const nextState = {
			...state,
			players: state.players.map((player) =>
				player.clientId === clientId ? { ...player, connected } : player,
			),
			updatedAt: new Date().toISOString(),
		};
		this.saveState(nextState);
		this.scheduleCleanup(nextState);
	}

	private loadState(): StoredGameState | null {
		const result = this.ctx.storage.sql
			.exec<RoomRow>("SELECT id, state, created_at, updated_at FROM rooms WHERE id = ?", ROOM_ROW_ID)
			.next();

		if (result.done) {
			return null;
		}

		return JSON.parse(result.value.state) as StoredGameState;
	}

	private saveState(state: StoredGameState): void {
		const serialized = JSON.stringify(state);
		this.ctx.storage.sql.exec(
			`
				INSERT INTO rooms (id, state, created_at, updated_at)
				VALUES (?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					state = excluded.state,
					updated_at = excluded.updated_at
			`,
			ROOM_ROW_ID,
			serialized,
			state.createdAt,
			state.updatedAt,
		);
	}

	private deleteState(): void {
		this.ctx.storage.sql.exec("DELETE FROM rooms WHERE id = ?", ROOM_ROW_ID);
	}

	private scheduleCleanup(state: StoredGameState): void {
		this.ctx.storage.setAlarm(getRoomExpirationAt(state));
	}
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "POST" && url.pathname === "/api/rooms") {
			return createRoom(request, env);
		}

		const roomApiMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)$/);
		if (request.method === "GET" && roomApiMatch) {
			return getRoomSnapshot(env, roomApiMatch[1]);
		}

		const wsMatch = url.pathname.match(/^\/ws\/rooms\/([^/]+)$/);
		if (request.method === "GET" && wsMatch) {
			return connectRoom(request, env, wsMatch[1]);
		}

		if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) {
			return json({ error: "not_found", message: "Route not found." }, 404);
		}

		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;

async function createRoom(request: Request, env: Env): Promise<Response> {
	const roomId = createRoomId();
	const stub = env.GAME_ROOM.getByName(roomId);
	await stub.initialize(roomId);

	const invitePath = `/room/${roomId}`;
	return json(
		{
			roomId,
			invitePath,
			inviteUrl: new URL(invitePath, request.url).toString(),
		},
		201,
	);
}

async function getRoomSnapshot(env: Env, roomId: string): Promise<Response> {
	if (!isValidRoomId(roomId)) {
		return jsonError("room_not_found", "This room does not exist.", 404);
	}

	const state = await env.GAME_ROOM.getByName(roomId).snapshot();
	if (!state) {
		return jsonError("room_not_found", "This room does not exist.", 404);
	}

	return json(state);
}

async function connectRoom(request: Request, env: Env, roomId: string): Promise<Response> {
	if (!isValidRoomId(roomId)) {
		return jsonError("room_not_found", "This room does not exist.", 404);
	}

	if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
		return jsonError("not_joined", "Expected a WebSocket upgrade request.", 426);
	}

	return env.GAME_ROOM.getByName(roomId).fetch(request);
}

function createRoomId(): string {
	return crypto.randomUUID().replaceAll("-", "");
}

function isValidRoomId(roomId: string): boolean {
	return ROOM_ID_PATTERN.test(roomId);
}

function parseClientMessage(
	message: string | ArrayBuffer,
): { ok: true; message: ClientMessage } | { ok: false; message: string } {
	if (typeof message !== "string") {
		return { ok: false, message: "Only text WebSocket messages are supported." };
	}

	try {
		const parsed: unknown = JSON.parse(message);
		if (!isClientMessage(parsed)) {
			return { ok: false, message: "Unsupported WebSocket message." };
		}

		return { ok: true, message: parsed };
	} catch {
		return { ok: false, message: "Message must be valid JSON." };
	}
}

function isClientMessage(value: unknown): value is ClientMessage {
	if (!value || typeof value !== "object" || !("type" in value)) {
		return false;
	}

	if (value.type === "join") {
		return (
			"clientId" in value &&
			typeof value.clientId === "string" &&
			"displayName" in value &&
			typeof value.displayName === "string"
		);
	}

	if (value.type === "placeStone") {
		return "x" in value && typeof value.x === "number" && "y" in value && typeof value.y === "number";
	}

	return false;
}

function getAttachment(ws: WebSocket): SocketAttachment {
	return (ws.deserializeAttachment() ?? {}) as SocketAttachment;
}

function normalizeDisplayName(displayName: string): string {
	const trimmed = displayName.trim();
	return trimmed ? trimmed.slice(0, 24) : "Player";
}

function updateStatusForPlayers(state: StoredGameState): StoredGameState {
	if (state.winner) {
		return { ...state, status: "finished" };
	}

	return {
		...state,
		status: state.players.length === 2 ? "playing" : "waiting",
	};
}

function send(ws: WebSocket, message: ServerMessage): void {
	try {
		ws.send(JSON.stringify(message));
	} catch {
		ws.close(1011, "send_failed");
	}
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, {
		status,
		headers: {
			"Cache-Control": "no-store",
		},
	});
}

function jsonError(code: MoveErrorCode | "not_found", message: string, status: number): Response {
	return json({ error: code, message }, status);
}
