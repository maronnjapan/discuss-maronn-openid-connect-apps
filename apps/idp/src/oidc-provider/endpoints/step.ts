/**
 * The description every step and every endpoint of the provider carries.
 *
 * A step is one function of an endpoint's pipeline, in a file of its own
 * (endpoints/<endpoint>/steps/<step-id>.ts, or features/<id>/.../steps/ for the
 * steps a feature adds). Its `meta` names it, says which values of the
 * pipeline it reads and defines, and whether `--flow` may leave it out.
 * `maronn-oidc graph` draws the provider from these descriptions, so a box of
 * the diagram is always one function of the code.
 *
 * The values a step reads and defines are the local names of the pipeline
 * (`params`, `client`, `validatedRequest`, ...). The request context `c` is
 * available to every step and is not listed.
 */

/**
 * The responsibility of a step: functions are split by what they do, so each
 * box does one kind of thing.
 */
export type StepKind =
  /** Read the HTTP request into typed values. */
  | 'parse'
  /** Look something up: a client, a token, a session, a key. */
  | 'resolve'
  /** Check a rule; fails with an OAuth / OIDC error. */
  | 'validate'
  /** Make a policy decision that later steps act on. */
  | 'decide'
  /** Answer a request that belongs to another grant or flow and stop. */
  | 'dispatch'
  /** Mint a token, a code, a record. */
  | 'issue'
  /** Write state to a store. */
  | 'persist'
  /** Turn values into another shape (a response body, a URL). */
  | 'transform'
  /** Turn the result into HTTP. */
  | 'respond';

export interface StepMeta {
  /** Unique within the endpoint (kebab-case); the id of the pipeline's marker line. */
  readonly id: string;
  /** The endpoint whose pipeline runs the step. */
  readonly endpoint: string;
  /** The feature that adds the step. Absent for the steps of every provider. */
  readonly feature?: string;
  readonly kind: StepKind;
  /** The name of the box. */
  readonly label: string;
  /** The specification section(s) the step implements. */
  readonly spec?: string;
  /** The exported function of the step. */
  readonly function: string;
  /** The core / experimental functions the step calls, in order. */
  readonly calls?: readonly string[];
  /** The pipeline values the step reads. */
  readonly consumes: readonly string[];
  /**
   * Values of consumes the step reads only when an earlier step defines them
   * (a step of a feature): without that step they are undefined, and the
   * diagram does not list them.
   */
  readonly optional?: readonly string[];
  /** The pipeline values the step defines. */
  readonly produces: readonly string[];
  /**
   * Whether `--flow` may leave the step out. A step that stays must not read
   * what a left-out step defines, unless that step has a fallback.
   */
  readonly removable: boolean;
  /**
   * When the step is left out, the values it defines are undefined, and the
   * steps that read them act as if it found nothing.
   */
  readonly fallback?: boolean;
  /** Steps it must stay after when `--flow` reorders the pipeline, beside its data. */
  readonly after?: readonly string[];
  /** Steps it must stay before. */
  readonly before?: readonly string[];
  /**
   * Steps that call this one. It is not a stage of the pipeline itself, and
   * stays while a caller stays.
   */
  readonly calledFrom?: readonly string[];
}

/** Describe a step. The function only checks the shape; it returns its argument. */
export function step<const M extends StepMeta>(meta: M): M {
  return meta;
}

/**
 * What a feature adds to a step of the provider without a block of its own:
 * a hook the step runs (a login method the describe-login-screen step renders,
 * for one). `maronn-oidc graph` adds the calls and the values to the box of
 * that step while the feature is generated.
 */
export interface StepContribution {
  readonly endpoint: string;
  /** The id of the step. */
  readonly step: string;
  readonly feature: string;
  readonly calls?: readonly string[];
  readonly consumes?: readonly string[];
  /** A specification the step then also implements, appended to its spec. */
  readonly spec?: string;
}

/** Describe a contribution. The function only checks the shape; it returns its argument. */
export function contribute<const C extends StepContribution>(contribution: C): C {
  return contribution;
}

/** An arrow of the diagram: between two steps of an endpoint, or between two endpoints. */
export interface EdgeMeta {
  readonly from: string;
  readonly to: string;
  readonly label?: string;
  /** flow: the normal path; branch: one of several alternatives; error: the path of a failure. */
  readonly kind: 'flow' | 'branch' | 'error';
}

/** An arrow between endpoints, with its place in the list of all such arrows. */
export interface JourneyMeta extends EdgeMeta {
  /** Arrows between endpoints are drawn in ascending order. */
  readonly order: number;
}

/**
 * The arrows between the steps of an endpoint.
 *
 * chain draws one arrow from each stage to the next, in the order of steps:
 * a stage is a step that is not the errorStep, not listed in `off` and not a
 * branch of a fork. A fork splits the chain after a stage: an arrow labelled
 * with the branch goes into each branch step that is there, and an arrow from
 * it to the next stage. fromKind draws an arrow from every step of a kind,
 * and extra lists arrows drawn as they are, when both ends are there.
 */
export interface EndpointEdges {
  readonly chain: boolean;
  /** Steps outside the chain: those another step calls (calledFrom). */
  readonly off?: readonly string[];
  readonly forks?: readonly { readonly at: string; readonly branches: readonly { readonly step: string; readonly label: string }[] }[];
  readonly fromKind?: readonly { readonly kind: StepKind; readonly to: string; readonly label: string }[];
  readonly extra?: readonly EdgeMeta[];
}

export interface EndpointMeta {
  /** Unique within the provider (kebab-case). */
  readonly id: string;
  /** Endpoints are listed (and mounted in the diagram) in ascending order. */
  readonly order: number;
  readonly label: string;
  /** The HTTP path, as app.ts mounts it. */
  readonly path: string;
  readonly methods: readonly string[];
  /** api: called by a client; browser: the End-User's browser is sent here; metadata: read before any flow. */
  readonly layer: 'api' | 'browser' | 'metadata';
  /** The flow of the protocol the endpoint belongs to. */
  readonly group: { readonly id: string; readonly label: string };
  readonly spec?: string;
  /** The feature that serves the endpoint. Absent for the endpoints of every provider. */
  readonly feature?: string;
  /**
   * Whether `--flow` may remove or reorder the steps. false for the screens,
   * whose steps are fixed entry points.
   */
  readonly rearrangeable: boolean;
  /** Values the pipeline has before its first step (read from the context). */
  readonly initial?: readonly string[];
  /**
   * The steps of the endpoint in the order of the diagram, those of the
   * features included (a step whose feature is not generated is left out).
   */
  readonly steps: readonly string[];
  /** The step every failing step ends in: the dashed arrows into it. */
  readonly errorStep?: string;
  readonly edges: EndpointEdges;
  /**
   * Arrows between endpoints: how a client or browser travels to and from
   * this one. Each arrow is listed by one of the endpoints it joins; an arrow
   * to an endpoint the provider does not have is not drawn.
   */
  readonly journeys?: readonly JourneyMeta[];
}

/** Describe an endpoint. The function only checks the shape; it returns its argument. */
export function defineEndpoint<const M extends EndpointMeta>(meta: M): M {
  return meta;
}
