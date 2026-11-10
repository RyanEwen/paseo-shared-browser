# DOM action scheduling and response limits

## Failure mechanism

PrintStream's Text editor could stop committing React state after an acknowledged semantic click. Later native clicks still reached their handlers, and timers still ran, but the initial effect's promises and microtasks were missing. A fresh native activation avoided the failure. A subsequent slow semantic fill also exposed Chromium's `Execution was terminated` error.

The fixed DOM action entry point used `Runtime.evaluate` with a 1,000 ms V8 execution deadline and a separate 1,500 ms response wait. Chromium's execution deadline includes the microtask checkpoint after the expression returns. The action can therefore compute `{acknowledged:true}` before V8 interrupts the application's queued work. Termination clears pending microtasks and can leave React's scheduling state stranded.

The pinned Chrome 155.0.8059.84 revision is `5869fe313571d75152b77813cf0a4ee26a4e6df0`. Its [DEPS](https://raw.githubusercontent.com/chromium/chromium/5869fe313571d75152b77813cf0a4ee26a4e6df0/DEPS) pins V8 to `712e1808de2d7416f1276d0deb1ee4ac978132b8`. The [runtime evaluator](https://raw.githubusercontent.com/v8/v8/712e1808de2d7416f1276d0deb1ee4ac978132b8/src/inspector/v8-runtime-agent-impl.cc) runs the checkpoint inside the deadline scope, and the [microtask queue](https://raw.githubusercontent.com/v8/v8/712e1808de2d7416f1276d0deb1ee4ac978132b8/src/execution/microtask-queue.cc) clears its pending jobs during termination.

## Limit review and correction

An application's reaction to an admitted click or edit is page behavior, not agent-supplied inspection code. Native input already lets that behavior finish without a V8 execution deadline. Semantic actions now do the same: the fixed, schema-checked entry point has no injected execution cutoff and inherits the existing CDP response wait used by native input, 15 seconds by default. The former 1,500 ms mutation override is removed as well.

The response wait bounds how long the tool awaits acknowledgement. It does not terminate page code, close a tab, cancel an authenticator, or retry an action. On expiry, the existing mutation transport reports an unknown outcome and the policy discards the element snapshot. Observe again before any further mutation. An already admitted action's application work may continue after a control handoff, just as work triggered by native input can continue.

Read-only snapshots and arbitrary inspection expressions retain their execution and output limits. Inspection still rejects side effects and needs a deadline for nonterminating expressions. The mutation's fixed helper still uses bounded traversal, text and option counts. Control, runtime, native attachment, document, snapshot expiry and exact element-reference checks are unchanged.

Element-based actions need no screenshot or streamed-frame receipt. Screenshot-coordinate input retains its separate policy because control ownership alone does not prevent the page from moving underneath previously observed coordinates. This correction does not change human or agent frame age limits, gesture cleanup or control leases.

The current native `shared_browser_input` route applies that receipt gate to keyboard and text events as well as coordinates. It should not be described as exclusively a pointer check. An element-targeted native keyboard operation could use an exact focused-element/document reference instead of screenshot age; that requires a separate interface and admission review. No such operation or frame-policy change is introduced here.

## Verification

The retained `DOM scheduling preserves application microtasks after slow element actions` regression in `tests/agent-dom.smoke.test.ts` uses real MCP tools, the supervisor and Chromium under an isolated home/profile. The original failing slice used a 1.2-second queued handler: the click acknowledged, but only `mount:start` remained instead of completion and the queued promise/microtask. The stronger final fixture verifies successful 2.2-second click and edit handlers. A 16.2-second action outlives the native response wait, reports an unknown outcome, finishes exactly once with its queued work intact, and allows a fresh snapshot and subsequent edit. The scenario requests zero frames. The existing form scenario retains inspection side-effect and infinite-loop rejection, no-control refusal, and document/tab/runtime replacement coverage.

The original isolated React 18.3.1 StrictMode fixture also reproduced the failure before the fix. A 1.25-second passive effect caused an acknowledged DOM action to stop near one second, lose its initial jobs and leave count 0 even after a trusted native increment. With this correction, both StrictMode mount passes finish, initial jobs run, the timer commits count -10, and the subsequent native increment commits -9. The corrected semantic activation completes in approximately 2.5 seconds, matching the native control. The slow React fill case separately checks retained application state rather than treating later timer activity as proof the edit succeeded.

These are controlled scheduling and Chromium proofs. The particular expensive PrintStream function was not profiled, and the original live editor was not modified or retried. The native regression does not qualify real account flows, passkey dialogs, graphics fidelity or deployment activation. Runtime changes require normal supervisor/runtime deployment; a bridge-only reload does not activate this correction.
