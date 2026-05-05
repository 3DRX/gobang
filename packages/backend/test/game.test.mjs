import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyMove,
	createInitialState,
	ensureTurnClock,
	finishByTimeout,
	getRoomExpirationAt,
	shouldTimeoutTurn,
	shouldDeleteRoom,
} from "../src/game.ts";

test("detects horizontal wins", () => {
	const state = play([
		[0, 0],
		[0, 1],
		[1, 0],
		[1, 1],
		[2, 0],
		[2, 1],
		[3, 0],
		[3, 1],
		[4, 0],
	]);

	assert.equal(state.winner, "black");
	assert.equal(state.winningLine.length, 5);
});

test("detects vertical wins", () => {
	const state = play([
		[0, 0],
		[1, 0],
		[0, 1],
		[1, 1],
		[0, 2],
		[1, 2],
		[0, 3],
		[1, 3],
		[0, 4],
	]);

	assert.equal(state.winner, "black");
	assert.equal(state.winningLine.length, 5);
});

test("detects diagonal wins", () => {
	const state = play([
		[0, 0],
		[1, 0],
		[1, 1],
		[2, 0],
		[2, 2],
		[3, 0],
		[3, 3],
		[4, 0],
		[4, 4],
	]);

	assert.equal(state.winner, "black");
	assert.equal(state.winningLine.length, 5);
});

test("detects anti-diagonal wins", () => {
	const state = play([
		[4, 0],
		[0, 0],
		[3, 1],
		[0, 1],
		[2, 2],
		[0, 2],
		[1, 3],
		[0, 3],
		[0, 4],
	]);

	assert.equal(state.winner, "black");
	assert.equal(state.winningLine.length, 5);
});

test("counts six in a row as a win", () => {
	const state = play([
		[0, 0],
		[0, 2],
		[1, 0],
		[2, 2],
		[2, 0],
		[4, 2],
		[4, 0],
		[6, 2],
		[5, 0],
		[8, 2],
		[3, 0],
	]);

	assert.equal(state.winner, "black");
	assert.equal(state.winningLine.length, 6);
});

test("rejects occupied and out-of-bounds moves", () => {
	let state = createInitialState("test-room");
	const first = applyMove(state, "black", 0, 0);
	assert.equal(first.ok, true);
	state = first.state;

	const occupied = applyMove(state, "white", 0, 0);
	assert.equal(occupied.ok, false);
	assert.equal(occupied.code, "occupied");

	const outOfBounds = applyMove(state, "white", 15, 0);
	assert.equal(outOfBounds.ok, false);
	assert.equal(outOfBounds.code, "out_of_bounds");
});

test("alternates turns and rejects moves after the game ends", () => {
	let state = createInitialState("test-room");
	let next = applyMove(state, "black", 0, 0);
	assert.equal(next.ok, true);
	state = next.state;
	assert.equal(state.turn, "white");

	const wrongTurn = applyMove(state, "black", 1, 0);
	assert.equal(wrongTurn.ok, false);
	assert.equal(wrongTurn.code, "not_your_turn");

	state = play([
		[0, 0],
		[0, 1],
		[1, 0],
		[1, 1],
		[2, 0],
		[2, 1],
		[3, 0],
		[3, 1],
		[4, 0],
	]);

	const afterWin = applyMove(state, "white", 4, 1);
	assert.equal(afterWin.ok, false);
	assert.equal(afterWin.code, "game_over");
});

test("expires unfinished rooms after the unfinished ttl", () => {
	const state = createInitialState("test-room", "2026-05-06T00:00:00.000Z");
	const policy = { unfinishedRoomTtlMs: 1_000, finishedRoomTtlMs: 100 };

	assert.equal(getRoomExpirationAt(state, policy), Date.parse("2026-05-06T00:00:01.000Z"));
	assert.equal(shouldDeleteRoom(state, Date.parse("2026-05-06T00:00:00.999Z"), policy), false);
	assert.equal(shouldDeleteRoom(state, Date.parse("2026-05-06T00:00:01.000Z"), policy), true);
});

test("expires finished rooms after the shorter finished ttl", () => {
	let state = play([
		[0, 0],
		[0, 1],
		[1, 0],
		[1, 1],
		[2, 0],
		[2, 1],
		[3, 0],
		[3, 1],
		[4, 0],
	]);
	state = { ...state, updatedAt: "2026-05-06T00:00:00.000Z" };
	const policy = { unfinishedRoomTtlMs: 1_000, finishedRoomTtlMs: 100 };

	assert.equal(getRoomExpirationAt(state, policy), Date.parse("2026-05-06T00:00:00.100Z"));
	assert.equal(shouldDeleteRoom(state, Date.parse("2026-05-06T00:00:00.099Z"), policy), false);
	assert.equal(shouldDeleteRoom(state, Date.parse("2026-05-06T00:00:00.100Z"), policy), true);
});

test("starts and advances the per-turn clock", () => {
	let state = createInitialState("test-room", "2026-05-06T00:00:00.000Z");
	state = ensureTurnClock({ ...state, status: "playing" }, Date.parse("2026-05-06T00:00:00.000Z"));

	assert.equal(state.turnDeadlineAt, "2026-05-06T00:01:00.000Z");
	assert.equal(shouldTimeoutTurn(state, Date.parse("2026-05-06T00:00:59.999Z")), false);
	assert.equal(shouldTimeoutTurn(state, Date.parse("2026-05-06T00:01:00.000Z")), true);

	const result = applyMove(state, "black", 0, 0, "2026-05-06T00:00:30.000Z");
	assert.equal(result.ok, true);
	assert.equal(result.state.turn, "white");
	assert.equal(result.state.turnDeadlineAt, "2026-05-06T00:01:30.000Z");
});

test("finishes the game when the current player times out", () => {
	let state = createInitialState("test-room", "2026-05-06T00:00:00.000Z");
	state = ensureTurnClock({ ...state, status: "playing" }, Date.parse("2026-05-06T00:00:00.000Z"));
	const timedOut = finishByTimeout(state, "2026-05-06T00:01:00.000Z");

	assert.equal(timedOut.status, "finished");
	assert.equal(timedOut.winner, "white");
	assert.equal(timedOut.timedOutSeat, "black");
	assert.equal(timedOut.turnDeadlineAt, null);
});

function play(points) {
	let state = createInitialState("test-room");
	for (const [index, [x, y]] of points.entries()) {
		const seat = index % 2 === 0 ? "black" : "white";
		const result = applyMove(state, seat, x, y);
		assert.equal(result.ok, true);
		state = result.state;
	}

	return state;
}
