/**
 * Type-level tests for custom request types
 * These should fail to type-check if the type safety is broken
 */

import type { Request } from 'workers/api/types';
import type {
  AuthedRequest,
  ActorRequest,
  ReadRequest,
  WriteRequest,
  MaintainerRequest,
  Principal,
} from './principal';

// =============================================================================
// Test 1: AuthedRequest cannot be assigned from plain Request
// =============================================================================

declare const plainRequest: Request;

// This should fail: AuthedRequest requires a principal property
const test1a: AuthedRequest = plainRequest; // Error: Type 'Request' is missing 'principal'

// =============================================================================
// Test 2: ActorRequest cannot be assigned from plain Request
// =============================================================================

const test2a: ActorRequest = plainRequest; // Error: Type 'Request' is missing 'principal', 'actorId'

// =============================================================================
// Test 3: ReadRequest cannot be assigned from plain Request
// =============================================================================

const test3a: ReadRequest = plainRequest; // Error: Type 'Request' is missing 'principal', 'actorId', 'scopes'

// =============================================================================
// Test 4: WriteRequest cannot be assigned from plain Request
// =============================================================================

const test4a: WriteRequest = plainRequest; // Error: Type 'Request' is missing 'principal', 'actorId', 'scopes'

// =============================================================================
// Test 5: MaintainerRequest cannot be assigned from plain Request
// =============================================================================

const test5a: MaintainerRequest = plainRequest; // Error: Type 'Request' is missing 'principal', 'actorId', 'scopes'

// =============================================================================
// Test 6: Branded types prevent structural compatibility
// =============================================================================

// Even if we try to create a structural match, it should fail
type FakeAuthedRequest = Request & { principal: Principal };
declare const fakeAuthed: FakeAuthedRequest;

const test6a: AuthedRequest = fakeAuthed; // Error: Type 'FakeAuthedRequest' is not assignable to 'AuthedRequest'

// =============================================================================
// Test 7: Handler signatures enforce correct types
// =============================================================================

// A handler that requires WriteRequest should not accept plain Request
function writeHandler(request: WriteRequest): Response {
  return new Response('ok');
}

writeHandler(plainRequest); // Error: Argument of type 'Request' is not assignable to 'WriteRequest'

// A handler that requires ReadRequest should not accept plain Request
function readHandler(request: ReadRequest): Response {
  return new Response('ok');
}

readHandler(plainRequest); // Error: Argument of type 'Request' is not assignable to 'ReadRequest'

// A handler that requires MaintainerRequest should not accept WriteRequest
function maintainerHandler(request: MaintainerRequest): Response {
  return new Response('ok');
}

// Even WriteRequest is not MaintainerRequest
declare const writeReq: WriteRequest;
maintainerHandler(writeReq); // Error: Argument of type 'WriteRequest' is not assignable to 'MaintainerRequest'

// =============================================================================
// Test 8: ActorRequest cannot be assigned from AuthedRequest without actorId
// =============================================================================

type PartialAuthedRequest = Request & { principal: Omit<Principal, 'actorId'> };
declare const partialAuthed: PartialAuthedRequest;

const test8a: ActorRequest = partialAuthed; // Error: Type is missing 'actorId'

// =============================================================================
// Test 9: Scope-specific types enforce scope guarantees
// =============================================================================

// ReadRequest guarantees 'read' is in scopes
function checkReadScope(request: ReadRequest): void {
  // At compile time, we know request.scopes includes 'read'
  const readScope: 'read' = request.scopes[0]; // This should work because 'read' is guaranteed
}

// WriteRequest guarantees 'write' is in scopes
function checkWriteScope(request: WriteRequest): void {
  const writeScope: 'write' = request.scopes[0]; // This should work because 'write' is guaranteed
}

// MaintainerRequest guarantees 'maintainer' is in scopes
function checkMaintainerScope(request: MaintainerRequest): void {
  const maintainerScope: 'maintainer' = request.scopes[0]; // This should work
}

// =============================================================================
// Test 10: AuthedRequest guarantees principal is available
// =============================================================================

function usePrincipal(request: AuthedRequest): Principal {
  return request.principal; // This should work - principal is guaranteed
}

// =============================================================================
// Test 11: ActorRequest guarantees actorId is available
// =============================================================================

function useActorId(request: ActorRequest): string {
  return request.actorId; // This should work - actorId is guaranteed
}

// =============================================================================
// Valid usage examples (these should NOT error)
// =============================================================================

// Creating a valid AuthedRequest (via wrapper)
declare const validAuthed: AuthedRequest;
declare const validActor: ActorRequest;
declare const validRead: ReadRequest;
declare const validWrite: WriteRequest;
declare const validMaintainer: MaintainerRequest;

// Handlers can accept their required types
writeHandler(validWrite); // OK
readHandler(validRead); // OK
maintainerHandler(validMaintainer); // OK

// ActorRequest can be used where AuthedRequest is expected (structural subtyping)
function acceptsAuthed(request: AuthedRequest): void {}
acceptsAuthed(validActor); // OK - ActorRequest extends AuthedRequest

// ReadRequest can be used where ActorRequest is expected
function acceptsActor(request: ActorRequest): void {}
acceptsActor(validRead); // OK - ReadRequest extends ActorRequest

// WriteRequest can be used where ActorRequest is expected
acceptsActor(validWrite); // OK - WriteRequest extends ActorRequest

// MaintainerRequest can be used where ActorRequest is expected
acceptsActor(validMaintainer); // OK - MaintainerRequest extends ActorRequest
