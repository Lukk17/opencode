export interface Registration {
  readonly dispose: () => Promise<void>
}

export interface ModelHookOptions {
  /** Limits the hook to one provider. Unscoped hooks apply to every provider. */
  readonly providerID?: string
}

export type Hooks<Spec> = <Name extends keyof Spec>(
  name: Name,
  callback: (input: Spec[Name]) => Promise<void> | void,
) => Promise<Registration>

export type ModelHooks<Spec, Options extends { readonly [Name in keyof Spec]?: ModelHookOptions } = {}> = <
  Name extends keyof Spec,
>(
  name: Name,
  callback: (input: Spec[Name]) => Promise<void> | void,
  options?: Spec[Name] extends { readonly model: unknown }
    ? Name extends keyof Options
      ? Options[Name]
      : ModelHookOptions
    : never,
) => Promise<Registration>

export type Transform<Input> = (callback: (input: Input) => void) => Promise<Registration>
