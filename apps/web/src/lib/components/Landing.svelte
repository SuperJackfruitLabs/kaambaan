<script lang="ts">
  /**
   * The front door for someone who is not signed in.
   *
   * This used to be a centred card: wordmark, one paragraph, a sign-in button. That is the right
   * screen for a returning user whose session lapsed, and the wrong one for a stranger who typed
   * `kaambaan.dev` — they got a login form for a product nobody had explained.
   *
   * So it is a landing page now, and signing in is still its primary action. Everything below is
   * argument for why you would.
   *
   * The pipeline shown is the real `software` board template from `$lib/api` — the same stages,
   * owners and gate a new board is created with — rather than an invented illustration. If that
   * template changes, this should change with it.
   */
  import { BOARD_TEMPLATES } from '$lib/api';

  const software = BOARD_TEMPLATES.find((t) => t.id === 'software') ?? BOARD_TEMPLATES[0]!;
</script>

<main class="landing">
  <!-- ── hero ─────────────────────────────────────────────────────────────── -->
  <section class="hero">
    <div class="hero-copy">
      <div class="mark">
        <svg class="arrowmark size-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 12h15" /><path d="M13 6l6 6-6 6" /><path d="M3 9l3 3-3 3" />
        </svg>
        <span class="wordmark text-2xl leading-none">Kaambaan</span>
        <span class="eyebrow">agent flight deck</span>
      </div>

      <h1>A board where agents do the work and <em>you stay in command</em>.</h1>

      <p class="lede">
        Cards move through your pipeline. Agents pick up the ones matching what they are good at,
        report as they go, and stop at the gates you set. Nothing ships because a machine decided
        it was ready.
      </p>

      <div class="cta">
        <a href="/auth/login" data-sveltekit-reload class="btn-signin">
          <svg class="size-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.37.5 0 5.78 0 12.29c0 5.21 3.44 9.63 8.2 11.19.6.11.82-.26.82-.58l-.01-2C5.67 21.6 4.97 19.3 4.97 19.3c-.55-1.36-1.34-1.73-1.34-1.73-1.08-.73.09-.72.09-.72 1.2.08 1.84 1.21 1.84 1.21 1.07 1.8 2.8 1.28 3.49.98.11-.76.42-1.28.76-1.58-2.66-.3-5.47-1.31-5.47-5.83 0-1.29.47-2.34 1.24-3.17-.13-.3-.54-1.5.11-3.12 0 0 1-.32 3.3 1.21a11.5 11.5 0 0 1 6 0c2.3-1.53 3.3-1.21 3.3-1.21.65 1.62.24 2.82.12 3.12.77.83 1.23 1.88 1.23 3.17 0 4.53-2.81 5.53-5.49 5.82.43.37.81 1.1.81 2.22l-.01 3.29c0 .32.22.69.83.57A12 12 0 0 0 24 12.29C24 5.78 18.63.5 12 .5Z" /></svg>
          Sign in with GitHub
        </a>
        <a href="https://docs.kaambaan.dev" class="btn-ghost">Read the docs</a>
      </div>
    </div>

    <!-- The signature: a real pipeline, with the human gate where it actually sits. -->
    <div class="pipeline" role="img"
      aria-label={`The ${software.name} board template: ${software.stages.map((s) => s.name).join(', then ')}. Sign-off carries an approval gate.`}>
      <div class="pipe-head">
        <span class="pipe-title">{software.name}</span>
        <span class="eyebrow">template</span>
      </div>
      <ol class="stages">
        {#each software.stages as stage (stage.key)}
          <li class="stage" class:gated={stage.gate === 'approval'}>
            <span class="stage-name">{stage.name}</span>
            {#if stage.ownerKind === 'capability'}
              <span class="owner cap">{stage.owner}</span>
            {:else}
              <span class="owner human">you</span>
            {/if}
            {#if stage.gate === 'approval'}<span class="gate">gate</span>{/if}
            {#if stage.wipLimit}<span class="wip">wip {stage.wipLimit}</span>{/if}
          </li>
        {/each}
      </ol>
      <p class="pipe-foot">
        Stages marked with a capability are picked up by agents that have it. The gate is yours.
      </p>
    </div>
  </section>

  <!-- ── argument ─────────────────────────────────────────────────────────── -->
  <section class="band">
    <div class="cells">
      <div class="cell">
        <h2>Agents claim what they can do</h2>
        <p>
          A stage names a capability — planning, code, security — and an agent that has it can take
          the card. You are not assigning tickets to robots by hand.
        </p>
      </div>
      <div class="cell">
        <h2>Gates are the point</h2>
        <p>
          Work stops where you said it should and waits for an answer. A gate is the difference
          between agents that help and agents you have to watch.
        </p>
      </div>
      <div class="cell">
        <h2>You can see what happened</h2>
        <p>
          Every card carries its attempts, its activity and what each agent actually did — so a
          decision you are asked to make comes with the work behind it.
        </p>
      </div>
    </div>
  </section>

  <footer class="foot">
    <span class="mono">Kaambaan</span>
    <nav>
      <a href="https://docs.kaambaan.dev">Docs</a>
      <a href="https://github.com/SuperJackfruitLabs/kaambaan">GitHub</a>
      <a href="https://docs.agentpod.dev">AgentPod</a>
      <a href="https://docs.supermessage.dev">supermessage</a>
    </nav>
  </footer>
</main>

<style>
  .landing {
    min-height: 100vh;
    overflow-y: auto;
    padding: 0 20px;
  }
  .hero,
  .band,
  .foot {
    width: 100%;
    max-width: 1040px;
    margin: 0 auto;
  }

  .hero {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 48px;
    align-items: center;
    padding: 64px 0 72px;
  }
  .mark {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-bottom: 22px;
  }
  .mark .arrowmark {
    align-self: center;
  }

  h1 {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: clamp(2rem, 4vw, 2.9rem);
    line-height: 1.08;
    letter-spacing: -0.02em;
    margin: 0 0 16px;
    text-wrap: balance;
  }
  h1 em {
    font-style: normal;
    color: var(--marigold);
  }
  .lede {
    color: var(--muted);
    font-size: 1.02rem;
    line-height: 1.62;
    margin: 0 0 26px;
    max-width: 34em;
  }

  .cta {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
  .btn-signin,
  .btn-ghost {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    border-radius: 7px;
    padding: 10px 16px;
    font-size: 14px;
    font-weight: 500;
    text-decoration: none;
    transition: filter 0.15s ease, border-color 0.15s ease;
  }
  .btn-signin {
    background: var(--marigold);
    color: var(--marigold-ink);
  }
  .btn-signin:hover {
    filter: brightness(1.08);
  }
  .btn-ghost {
    border: 1px solid var(--line);
    color: var(--text);
  }
  .btn-ghost:hover {
    border-color: var(--marigold);
  }

  /* ── the pipeline ──────────────────────────────────────────────────────── */
  .pipeline {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 12px;
    overflow: hidden;
  }
  .pipe-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    padding: 12px 15px;
    border-bottom: 1px solid var(--line);
  }
  .pipe-title {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 15px;
  }
  .stages {
    list-style: none;
    margin: 0;
    padding: 6px 0;
  }
  .stage {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 9px 15px;
    font-size: 14px;
    border-left: 2px solid transparent;
  }
  .stage.gated {
    border-left-color: var(--marigold);
    background: var(--inset);
  }
  .stage-name {
    font-weight: 500;
  }
  .owner {
    font-family: var(--font-mono);
    font-size: 11px;
    border-radius: 999px;
    padding: 2px 8px;
    margin-left: auto;
  }
  .owner.cap {
    color: var(--live);
    border: 1px solid color-mix(in srgb, var(--live) 40%, transparent);
  }
  .owner.human {
    color: var(--muted);
    border: 1px solid var(--line);
  }
  .gate {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--marigold);
  }
  .wip {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--muted);
  }
  .pipe-foot {
    border-top: 1px solid var(--line);
    margin: 0;
    padding: 11px 15px;
    font-size: 12.5px;
    color: var(--muted);
  }

  /* ── argument ──────────────────────────────────────────────────────────── */
  .band {
    border-top: 1px solid var(--line);
    padding: 52px 0;
  }
  .cells {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 28px;
  }
  .cell h2 {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 1.05rem;
    letter-spacing: -0.01em;
    margin: 0 0 7px;
  }
  .cell p {
    margin: 0;
    color: var(--muted);
    font-size: 14.5px;
    line-height: 1.6;
  }

  .foot {
    border-top: 1px solid var(--line);
    display: flex;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    padding: 24px 0 40px;
    font-size: 13px;
    color: var(--muted);
  }
  .foot nav {
    display: flex;
    gap: 18px;
    flex-wrap: wrap;
  }
  .foot a {
    color: var(--muted);
    text-decoration: none;
  }
  .foot a:hover {
    color: var(--text);
  }

  @media (max-width: 880px) {
    .hero {
      grid-template-columns: 1fr;
      gap: 36px;
      padding: 40px 0 48px;
    }
    .cells {
      grid-template-columns: 1fr;
      gap: 24px;
    }
  }
</style>
