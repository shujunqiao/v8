// Copyright 2016 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

(function(global, utils, extrasUtils) {

"use strict";

%CheckIsBootstrapping();

// -------------------------------------------------------------------
// Imports

var AsyncFunctionNext;
var AsyncFunctionThrow;
var CreateInternalPromiseCapability;
var PromiseCreate;
var PromiseNextMicrotaskID;
var RejectPromise;

utils.Import(function(from) {
  AsyncFunctionNext = from.AsyncFunctionNext;
  AsyncFunctionThrow = from.AsyncFunctionThrow;
  CreateInternalPromiseCapability = from.CreateInternalPromiseCapability;
  PromiseCreate = from.PromiseCreate;
  RejectPromise = from.RejectPromise;
});

var promiseAsyncStackIDSymbol =
    utils.ImportNow("promise_async_stack_id_symbol");
var promiseHandledBySymbol =
    utils.ImportNow("promise_handled_by_symbol");
var promiseForwardingHandlerSymbol =
    utils.ImportNow("promise_forwarding_handler_symbol");
var promiseHandledHintSymbol =
    utils.ImportNow("promise_handled_hint_symbol");

// -------------------------------------------------------------------

function PromiseCastResolved(value) {
  // TODO(caitp): This is non spec compliant. See v8:5694.
  if (%is_promise(value)) {
    return value;
  } else {
    var promise = PromiseCreate();
    %promise_resolve(promise, value);
    return promise;
  }
}

// ES#abstract-ops-async-function-await
// AsyncFunctionAwait ( value )
// Shared logic for the core of await. The parser desugars
//   await awaited
// into
//   yield AsyncFunctionAwait{Caught,Uncaught}(.generator, awaited, .promise)
// The 'awaited' parameter is the value; the generator stands in
// for the asyncContext, and .promise is the larger promise under
// construction by the enclosing async function.
function AsyncFunctionAwait(generator, awaited, outerPromise) {
  // Promise.resolve(awaited).then(
  //     value => AsyncFunctionNext(value),
  //     error => AsyncFunctionThrow(error)
  // );
  var promise = PromiseCastResolved(awaited);

  var onFulfilled = sentValue => {
    %_Call(AsyncFunctionNext, generator, sentValue);
    // The resulting Promise is a throwaway, so it doesn't matter what it
    // resolves to. What is important is that we don't end up keeping the
    // whole chain of intermediate Promises alive by returning the value
    // of AsyncFunctionNext, as that would create a memory leak.
    return;
  };
  var onRejected = sentError => {
    %_Call(AsyncFunctionThrow, generator, sentError);
    // Similarly, returning the huge Promise here would cause a long
    // resolution chain to find what the exception to throw is, and
    // create a similar memory leak, and it does not matter what
    // sort of rejection this intermediate Promise becomes.
    return;
  }

  // Just forwarding the exception, so no debugEvent for throwawayCapability.
  var throwawayCapability = CreateInternalPromiseCapability(promise);

  // The Promise will be thrown away and not handled, but it shouldn't trigger
  // unhandled reject events as its work is done
  %PromiseMarkAsHandled(throwawayCapability.promise);

  if (DEBUG_IS_ACTIVE) {
    if (%is_promise(awaited)) {
      // Mark the reject handler callback to be a forwarding edge, rather
      // than a meaningful catch handler
      SET_PRIVATE(onRejected, promiseForwardingHandlerSymbol, true);
    }

    // Mark the dependency to outerPromise in case the throwaway Promise is
    // found on the Promise stack
    SET_PRIVATE(throwawayCapability.promise, promiseHandledBySymbol,
                outerPromise);
  }

  %perform_promise_then(promise, onFulfilled, onRejected, throwawayCapability);
}

// Called by the parser from the desugaring of 'await' when catch
// prediction indicates no locally surrounding catch block
function AsyncFunctionAwaitUncaught(generator, awaited, outerPromise) {
  AsyncFunctionAwait(generator, awaited, outerPromise);
}

// Called by the parser from the desugaring of 'await' when catch
// prediction indicates that there is a locally surrounding catch block
function AsyncFunctionAwaitCaught(generator, awaited, outerPromise) {
  if (DEBUG_IS_ACTIVE && %is_promise(awaited)) {
    SET_PRIVATE(awaited, promiseHandledHintSymbol, true);
  }
  AsyncFunctionAwait(generator, awaited, outerPromise);
}

// How the parser rejects promises from async/await desugaring
function RejectPromiseNoDebugEvent(promise, reason) {
  return RejectPromise(promise, reason, false);
}

function AsyncFunctionPromiseCreate() {
  var promise = PromiseCreate();
  if (DEBUG_IS_ACTIVE) {
    // Push the Promise under construction in an async function on
    // the catch prediction stack to handle exceptions thrown before
    // the first await.
    %DebugPushPromise(promise);
    // Assign ID and create a recurring task to save stack for future
    // resumptions from await.
    var id = %DebugNextMicrotaskId();
    SET_PRIVATE(promise, promiseAsyncStackIDSymbol, id);
    %DebugAsyncTaskEvent("enqueueRecurring", id, "async function");
  }
  return promise;
}

function AsyncFunctionPromiseRelease(promise) {
  if (DEBUG_IS_ACTIVE) {
    // Cancel
    var id = GET_PRIVATE(promise, promiseAsyncStackIDSymbol);

    // Don't send invalid events when catch prediction is turned on in
    // the middle of some async operation.
    if (!IS_UNDEFINED(id)) {
      %DebugAsyncTaskEvent("cancel", id, "async function");
    }
    // Pop the Promise under construction in an async function on
    // from catch prediction stack.
    %DebugPopPromise();
  }
}

%InstallToContext([
  "async_function_await_caught", AsyncFunctionAwaitCaught,
  "async_function_await_uncaught", AsyncFunctionAwaitUncaught,
  "reject_promise_no_debug_event", RejectPromiseNoDebugEvent,
  "async_function_promise_create", AsyncFunctionPromiseCreate,
  "async_function_promise_release", AsyncFunctionPromiseRelease,
]);

})
