/**
 * Execute-path tests for the deepseek_delegate tool (plan todo 7).
 *
 * Credential-free and DSH-free: every test drives the exported core
 * (`runDelegate`, `queryJobOutput`, `cancelDelegateJob` from
 * src/delegate-execute.ts) with STUBBED job-boundary deps (startJob /
 * readOutput / cancelJob). No child process is ever spawned, so no orphan
 * risk exists by construction. The wrapper wiring (default + output + cancel
 * exports) is asserted in one import-level test.
 *
 * Coverage:
 *   happy    – stub ok result → structured completed output (session_id,
 *              finish_reason verbatim, final_response truncated, audit_path
 *              placeholder);
 *   failure  – exit-1-style ok:false stub → structured error, never
 *              completed;
 *   malformed– garbage/parse-error output → structured error with REDACTED
 *              preview;
 *   gate     – unrestricted without token → error BEFORE any job start;
 *   background – run_in_background:true returns running immediately;
 *   deadline – sync poll past the deadline → cancel() called once, error
 *              TIMEOUT;
 *   abort    – caller abort during sync wait → cancel(), error ABORTED;
 *   companions – output tool view transitions running→completed; cancel
 *              tool on running job → cancelled, on terminal job → structured
 *              JOB_NOT_RUNNING;
 *   wiring   – default export args === deepseekDelegateInputSchema.shape;
 *              output/cancel tool definitions exist with job_id args.
 */
import { expect, test } from 'bun:test'
import defaultTool, { cancel as cancelTool, output as outputTool } from '../.opencode/tools/deepseek_delegate.ts'

import {
  cancelDelegateJob,
  conciseOutput,
  delegateResultText,
  queryJobOutput,
  runDelegate,
  type RunDelegateDeps,
} from '../src/delegate-execute.ts'
import { JobError } from '../src/jobs.ts'
import {
  deepseekDelegateInputSchema,
  deepseekDelegateOutputSchema,
  type DelegateInput,
  type DelegateJob,
  type DelegateOutput,
} from '../src/schema.ts'

/* ------------------------------------------------------------------ */
/* Fixtures + stub helpers                                             */
/* ------------------------------------------------------------------ */

const CWD = '/workspace/example-repo' // never touched: all seams are stubbed

function exploreInput(overrides: Partial<DelegateInput> = {}): DelegateInput {
  return {
    preset: 'explore',
    prompt: 'Map this repository: structure, entry points, conventions.',
    cwd: CWD,
    ...overrides,
  }
}

function runningRecord(jobId = 'bg_1234567890ab', input: DelegateInput = exploreInput()): DelegateJob {
  const defaults =
    input.preset === 'unrestricted'
      ? { model: 'deepseek-v4-flash', permission_mode: 'danger-full-access' as const }
      : input.preset === 'vision'
        ? { model: 'deepseek-v4-flash-vision-exp', permission_mode: 'read-only' as const }
        : input.preset === 'write'
          ? { model: 'deepseek-v4-flash', permission_mode: 'workspace-write' as const }
          : { model: 'deepseek-v4-flash', permission_mode: 'read-only' as const }
  return {
    job_id: jobId,
    preset: input.preset,
    created_at: new Date().toISOString(),
    cwd: input.cwd,
    status: 'running',
    model: defaults.model,
    permission_mode: defaults.permission_mode,
  }
}

function completedView(jobId = 'bg_1234567890ab'): { output: DelegateOutput; stdout_tail: string; stderr_tail: string } {
  return {
    output: {
      status: 'completed',
      preset: 'explore',
      job_id: jobId,
      session_id: 'ses_stub_completed_1',
      model: 'deepseek-v4-flash',
      permission_mode: 'read-only',
      final_response: 'The repo is a delegation harness.'.repeat(400), // well over the cap
      finish_reason: 'completed',
    },
    stdout_tail: 'stub: done',
    stderr_tail: '',
  }
}

function errorView(code: string, message: string, jobId = 'bg_1234567890ab'): { output: DelegateOutput; stdout_tail: string; stderr_tail: string } {
  return {
    output: {
      status: 'error',
      preset: 'explore',
      job_id: jobId,
      model: 'deepseek-v4-flash',
      permission_mode: 'read-only',
      error: { code, message },
    },
    stdout_tail: '',
    stderr_tail: '',
  }
}

function expectValidOutput(output: DelegateOutput): void {
  const parsed = deepseekDelegateOutputSchema.safeParse(output)
  expect(parsed.success).toBe(true)
}

/* ------------------------------------------------------------------ */
/* happy: structured completed result                                  */
/* ------------------------------------------------------------------ */

test('runDelegate happy: stubbed ok result → structured completed output (session_id, finish_reason verbatim, truncated final_response, audit placeholder)', async () => {
  const startedJobs: unknown[] = []
  const result = await runDelegate(exploreInput(), {
    startJob: async (spec) => {
      startedJobs.push(spec)
      return runningRecord()
    },
    readOutput: async () => completedView(),
    cancelJob: async () => {
      throw new Error('cancel must not be called on the happy path')
    },
  })

  expectValidOutput(result)
  expect(startedJobs).toHaveLength(1)
  expect(result.status).toBe('completed')
  expect(result.preset).toBe('explore')
  expect(result.model).toBe('deepseek-v4-flash')
  expect(result.permission_mode).toBe('read-only')
  expect(result.job_id).toBe('bg_1234567890ab')
  expect(result.session_id).toBe('ses_stub_completed_1')
  expect(result.finish_reason).toBe('completed')
  // audit_path is the todo-10 reserved placeholder, present for job-backed outputs.
  expect(result.audit_path).toContain('.omo/deepseek-delegate/audit/')
  expect(result.audit_path).toContain('bg_1234567890ab.json')
  // final_response truncated at FINAL_RESPONSE_MAX_CHARS with a visible marker.
  expect(result.final_response).toBeDefined()
  expect(result.final_response!.length).toBe(4000 + '... [truncated]'.length)
  expect(result.final_response!.endsWith('... [truncated]')).toBe(true)
  expect(result.error).toBeUndefined()

  // The string payload renders as the structured JSON the tool returns.
  const text = delegateResultText(result)
  const roundTrip = JSON.parse(text) as DelegateOutput
  expect(roundTrip.status).toBe('completed')
  expect(roundTrip.finish_reason).toBe('completed')
  expect(roundTrip.final_response!.endsWith('... [truncated]')).toBe(true)
})

/* ------------------------------------------------------------------ */
/* failure: ok:false (exit-1 class) result                             */
/* ------------------------------------------------------------------ */

test('runDelegate failure: stub runner ok:false error → structured error output, never completed', async () => {
  const result = await runDelegate(exploreInput(), {
    startJob: async () => runningRecord('bg_feedfacebead'),
    readOutput: async () =>
      errorView('AGENT_ERROR', 'agent turn failed mid-run (simulated exit 1)', 'bg_feedfacebead'),
    cancelJob: async () => {
      throw new Error('cancel must not be called')
    },
  })

  expectValidOutput(result)
  expect(result.status).toBe('error')
  expect(result.status).not.toBe('completed')
  expect(result.job_id).toBe('bg_feedfacebead')
  expect(result.error?.code).toBe('AGENT_ERROR')
  expect(result.error?.message).toContain('simulated exit 1')
  expect(result.final_response).toBeUndefined()
  expect(JSON.stringify(result)).not.toContain('"status": "completed"')
})

/* ------------------------------------------------------------------ */
/* malformed / garbage output → redacted parse error                   */
/* ------------------------------------------------------------------ */

test('runDelegate failure: garbage runner output → structured error with redacted preview, never completed', async () => {
  const garbage =
    'delegate runner exited with code 2 without a result line; stderr tail: ' +
    '{"ok":true "broken json sk-LIVE_SECRET_abc123def4567890 more garbage'
  const result = await runDelegate(exploreInput(), {
    startJob: async () => runningRecord('bg_0badc0debeef'),
    readOutput: async () => errorView('RUNNER_EXIT', garbage, 'bg_0badc0debeef'),
    cancelJob: async () => {
      throw new Error('cancel must not be called')
    },
  })

  expectValidOutput(result)
  expect(result.status).toBe('error')
  expect(result.status).not.toBe('completed')
  expect(result.error?.code).toBe('RUNNER_EXIT')
  expect(result.error?.message).toContain('[REDACTED]')
  expect(result.error?.message).not.toContain('sk-LIVE_SECRET')
  expect(result.error?.message).toContain('broken json') // readable preview retained
})

test('runDelegate failure: readOutput throws malformed-job error → structured error with redacted message', async () => {
  const thrown = new JobError(
    'JOB_INVALID',
    `cannot parse result line for job "bg_bad": {"ok":true garbage sk-ANOTHER_SECRET_value987654321}`,
  )
  const result = await runDelegate(exploreInput(), {
    startJob: async () => runningRecord('bg_badc0ffee000'),
    readOutput: async () => {
      throw thrown
    },
    cancelJob: async () => {
      throw new Error('cancel must not be called')
    },
  })

  expectValidOutput(result)
  expect(result.status).toBe('error')
  expect(result.error?.code).toBe('JOB_INVALID')
  expect(result.error?.message).not.toContain('sk-ANOTHER_SECRET')
  expect(result.error?.message).toContain('[REDACTED]')
  expect(JSON.stringify(result)).not.toContain('"status": "completed"')
})

/* ------------------------------------------------------------------ */
/* gate: unrestricted without token never reaches a job                */
/* ------------------------------------------------------------------ */

test('runDelegate gate: unrestricted without confirmation token → schema error BEFORE any job start', async () => {
  const forged = {
    preset: 'unrestricted' as const,
    prompt: 'run free',
    cwd: CWD,
    // confirm_unrestricted intentionally omitted (bypasses schema typing)
  }
  const result = await runDelegate(forged as unknown as DelegateInput, {
    startJob: async () => {
      throw new Error('startJob must never be called for an ungated unrestricted run')
    },
    readOutput: async () => {
      throw new Error('readOutput must never be called')
    },
    cancelJob: async () => {
      throw new Error('cancelJob must never be called')
    },
  })

  expectValidOutput(result)
  expect(result.status).toBe('error')
  expect(result.error?.code).toBe('SCHEMA_INVALID')
  expect(result.error?.message).toContain('confirm_unrestricted')
  expect(result.permission_mode).toBe('danger-full-access') // identity of the ATTEMPTED preset
  expect(JSON.stringify(result)).not.toContain('"status": "completed"')
})

test('runDelegate gate: write without context packet or allow_auto_context → schema error before any job start', async () => {
  const forged = { preset: 'write' as const, prompt: 'do a thing', cwd: CWD }
  const result = await runDelegate(forged as unknown as DelegateInput, {
    startJob: async () => {
      throw new Error('startJob must never be called for an invalid write run')
    },
    readOutput: async () => {
      throw new Error('readOutput must never be called')
    },
    cancelJob: async () => {
      throw new Error('cancelJob must never be called')
    },
  })
  expectValidOutput(result)
  expect(result.status).toBe('error')
  expect(result.error?.code).toBe('SCHEMA_INVALID')
  expect(result.error?.message).toContain('context_packet')
})

/* ------------------------------------------------------------------ */
/* background start                                                    */
/* ------------------------------------------------------------------ */

test('runDelegate background: run_in_background:true returns running immediately (no polling)', async () => {
  const result = await runDelegate(
    { ...exploreInput(), run_in_background: true },
    {
      startJob: async () => runningRecord('bg_abcdef012345'),
      readOutput: async () => {
        throw new Error('readOutput must not be called for a background start')
      },
      cancelJob: async () => {
        throw new Error('cancel must not be called')
      },
    },
  )

  expectValidOutput(result)
  expect(result.status).toBe('running')
  expect(result.job_id).toBe('bg_abcdef012345')
  expect(result.preset).toBe('explore')
  expect(result.model).toBe('deepseek-v4-flash')
  expect(result.permission_mode).toBe('read-only')
  expect(result.finish_reason).toBeUndefined()
  expect(result.error).toBeUndefined()
})

/* ------------------------------------------------------------------ */
/* sync deadline → cancel + TIMEOUT                                    */
/* ------------------------------------------------------------------ */

test('runDelegate sync: deadline exceeded → cancel called once and error TIMEOUT (fake clock)', async () => {
  let clock = 0
  let reads = 0
  let cancels = 0
  const result = await runDelegate(
    { ...exploreInput(), timeout_ms: 1000 },
    {
      startJob: async () => runningRecord('bg_timeout00001'),
      readOutput: async () => {
        reads += 1
        // Never terminal: the deadline must win.
        return {
          output: {
            status: 'running',
            preset: 'explore',
            job_id: 'bg_timeout00001',
            model: 'deepseek-v4-flash',
            permission_mode: 'read-only',
          },
          stdout_tail: 'still working…',
          stderr_tail: '',
        }
      },
      cancelJob: async () => {
        cancels += 1
        return { ...runningRecord('bg_timeout00001'), status: 'cancelled' }
      },
      now: () => clock,
      sleep: async () => {
        clock += 250 // 250 ms per poll, matching POLL_INTERVAL_MS semantics
      },
    },
  )

  expectValidOutput(result)
  expect(result.status).toBe('error')
  expect(result.error?.code).toBe('TIMEOUT')
  expect(result.error?.message).toContain('1000 ms')
  expect(result.job_id).toBe('bg_timeout00001')
  expect(reads).toBe(4) // polls at t=0,250,500,750; deadline fires at t=1000
  expect(cancels).toBe(1)
  expect(JSON.stringify(result)).not.toContain('"status": "completed"')
})

/* ------------------------------------------------------------------ */
/* caller abort during sync wait                                       */
/* ------------------------------------------------------------------ */

test('runDelegate sync: caller abort → cancel called and structured ABORTED error', async () => {
  const controller = new AbortController()
  let cancels = 0
  const deps: RunDelegateDeps = {
    startJob: async () => runningRecord('bg_abort000001'),
    readOutput: async () => {
      // Simulate the caller aborting while the job is still running.
      controller.abort()
      return {
        output: {
          status: 'running',
          preset: 'explore',
          job_id: 'bg_abort000001',
          model: 'deepseek-v4-flash',
          permission_mode: 'read-only',
        },
        stdout_tail: '',
        stderr_tail: '',
      }
    },
    cancelJob: async () => {
      cancels += 1
      return { ...runningRecord('bg_abort000001'), status: 'cancelled' }
    },
    abortSignal: controller.signal,
    sleep: async () => {}, // never reached
  }

  const result = await runDelegate(exploreInput(), deps)
  expectValidOutput(result)
  expect(result.status).toBe('error')
  expect(result.error?.code).toBe('ABORTED')
  expect(cancels).toBe(1)
})

/* ------------------------------------------------------------------ */
/* companions: output view + cancel                                    */
/* ------------------------------------------------------------------ */

test('companion output: running view then completed view (stubbed JobManager status)', async () => {
  let calls = 0
  const deps: RunDelegateDeps = {
    startJob: async () => {
      throw new Error('startJob must not be called')
    },
    readOutput: async () => {
      calls += 1
      if (calls === 1) {
        return {
          output: {
            status: 'running',
            preset: 'explore',
            job_id: 'bg_1234567890ab',
            model: 'deepseek-v4-flash',
            permission_mode: 'read-only',
          },
          stdout_tail: 'progress… with sk-LIVE_SECRET_xyz9876543210 inside',
          stderr_tail: '',
        }
      }
      return completedView()
    },
    cancelJob: async () => {
      throw new Error('cancel must not be called')
    },
  }

  const first = await queryJobOutput('bg_1234567890ab', deps)
  expect(first.ok).toBe(true)
  if (!first.ok) return
  expect(first.view.output.status).toBe('running')
  expect(first.view.output.job_id).toBe('bg_1234567890ab')
  expect(first.view.stdout_tail).not.toContain('sk-LIVE_SECRET') // redacted
  expect(first.view.stdout_tail).toContain('[REDACTED]')

  const second = await queryJobOutput('bg_1234567890ab', deps)
  expect(second.ok).toBe(true)
  if (!second.ok) return
  expect(second.view.output.status).toBe('completed')
  expect(second.view.output.session_id).toBe('ses_stub_completed_1')
  expect(second.view.output.finish_reason).toBe('completed')
  expectValidOutput(second.view.output)
})

test('companion output: unknown job → structured ok:false (never throws)', async () => {
  const result = await queryJobOutput('bg_doesnotexist0', {
    startJob: async () => {
      throw new Error('unused')
    },
    readOutput: async () => {
      throw new JobError('JOB_NOT_FOUND', 'no job with id "bg_doesnotexist0" under /tmp/jobs')
    },
    cancelJob: async () => {
      throw new Error('unused')
    },
  })
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.error.code).toBe('JOB_NOT_FOUND')
  expect(result.error.message).toContain('bg_doesnotexist0')
})

test('companion cancel: running job → ok with status cancelled', async () => {
  const seen: string[] = []
  const result = await cancelDelegateJob('bg_cancel000001', {
    startJob: async () => {
      throw new Error('unused')
    },
    readOutput: async () => {
      throw new Error('unused')
    },
    cancelJob: async (jobId) => {
      seen.push(jobId)
      return { ...runningRecord('bg_cancel000001'), status: 'cancelled' }
    },
  })
  expect(seen).toEqual(['bg_cancel000001'])
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expectValidOutput(result.output)
  expect(result.output.status).toBe('cancelled')
  expect(result.output.job_id).toBe('bg_cancel000001')
  expect(result.output.error).toBeUndefined()
})

test('companion cancel: terminal job → structured JOB_NOT_RUNNING ok:false', async () => {
  const result = await cancelDelegateJob('bg_done00000001', {
    startJob: async () => {
      throw new Error('unused')
    },
    readOutput: async () => {
      throw new Error('unused')
    },
    cancelJob: async () => {
      throw new JobError('JOB_NOT_RUNNING', 'job "bg_done00000001" is completed; only running jobs can be cancelled')
    },
  })
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.error.code).toBe('JOB_NOT_RUNNING')
  expect(result.error.message).toContain('completed')
})

/* ------------------------------------------------------------------ */
/* wrapper wiring                                                      */
/* ------------------------------------------------------------------ */

test('wiring: default export is the tool backed by deepseekDelegateInputSchema; output/cancel exports exist', () => {
  // The plugin's tool() is an identity wrapper, so the args object IS the
  // schema's raw shape — proving the exact schema powers the tool.
  expect(typeof defaultTool).toBe('object')
  expect(typeof defaultTool.description).toBe('string')
  expect(defaultTool.description.length).toBeGreaterThan(50)
  expect(typeof defaultTool.execute).toBe('function')
  expect(defaultTool.args).toBe(deepseekDelegateInputSchema.shape)
  const shapeKeys = Object.keys(deepseekDelegateInputSchema.shape).sort()
  const argKeys = Object.keys(defaultTool.args).sort()
  expect(argKeys).toEqual(shapeKeys)
  for (const key of shapeKeys) {
    expect((defaultTool.args as Record<string, unknown>)[key]).toBe(
      (deepseekDelegateInputSchema.shape as Record<string, unknown>)[key],
    )
  }

  // Companion exports (opencode names them deepseek_delegate_output /
  // deepseek_delegate_cancel).
  expect(typeof outputTool).toBe('object')
  expect(typeof outputTool.execute).toBe('function')
  expect('job_id' in outputTool.args).toBe(true)
  expect(typeof cancelTool).toBe('object')
  expect(typeof cancelTool.execute).toBe('function')
  expect('job_id' in cancelTool.args).toBe(true)
})

test('conciseOutput never fabricates completed and truncates long responses', () => {
  const source: DelegateOutput = {
    status: 'completed',
    preset: 'explore',
    model: 'deepseek-v4-flash',
    permission_mode: 'read-only',
    final_response: 'x'.repeat(10_000),
    finish_reason: 'max-tokens', // surfaced verbatim, never hidden
  }
  const concise = conciseOutput(source)
  expect(concise.status).toBe('completed')
  expect(concise.finish_reason).toBe('max-tokens')
  expect(concise.final_response!.length).toBe(4000 + '... [truncated]'.length)
  expectValidOutput(concise)
})
