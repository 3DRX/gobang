import assert from "node:assert/strict";
import { test } from "node:test";
import { applyMove, createInitialState } from "../src/game.ts";

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
