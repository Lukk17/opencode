import { createUniqueId, For, Show } from "solid-js"

/** A message the user did not type: one line with a short label that opens to its full text and closes again. */
export function CollapsedMessage(props: {
  label: string
  /** Shown after the label on the same line. */
  data?: string
  /** Shown after the label on the same line, each truncated on its own, in place of `data`. */
  items?: readonly string[]
  text: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Inside a group of notices, which uses tighter spacing. */
  grouped?: boolean
  class?: string
}) {
  const id = createUniqueId()

  return (
    <div data-component="collapsed-message" class={`w-full ${props.class ?? ""}`}>
      <button
        type="button"
        data-slot="session-timeline-notice"
        aria-expanded={props.open}
        aria-controls={id}
        class="block w-full text-start cursor-pointer text-v2-text-text-faint outline-none hover:text-v2-text-text-base focus-visible:text-v2-text-text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-border-border-focus"
        classList={{
          "py-1": props.grouped || !!props.items?.length,
          "pt-3 pb-1": !props.grouped && !props.items?.length,
          "truncate text-13-regular leading-text-compact": !props.items?.length,
        }}
        onClick={() => props.onOpenChange(!props.open)}
      >
        <Show
          when={props.items?.length ? props.items : undefined}
          fallback={
            <>
              <bdi dir="auto" class="font-[530]">
                {props.label}
              </bdi>
              <Show when={props.data}>
                {(data) => (
                  <span>
                    {" · "}
                    <bdi dir="auto">{data()}</bdi>
                  </span>
                )}
              </Show>
            </>
          }
        >
          {(items) => (
            <div class="flex min-h-5 min-w-0 items-center gap-2 overflow-hidden">
              <bdi dir="auto" class="shrink-0 text-[13px] font-[530] leading-text-compact tracking-[-0.04px]">
                {props.label}
              </bdi>
              <For each={items()}>
                {(item) => (
                  <bdi
                    dir="auto"
                    class="min-w-0 truncate text-[13px] font-[440] leading-text-compact tracking-[-0.04px]"
                  >
                    {item}
                  </bdi>
                )}
              </For>
            </div>
          )}
        </Show>
      </button>
      <Show when={props.open}>
        <div
          id={id}
          data-slot="collapsed-message-text"
          dir="auto"
          class="whitespace-pre-wrap break-words pb-1 text-13-regular leading-text-compact text-v2-text-text-muted"
        >
          {props.text}
        </div>
      </Show>
    </div>
  )
}
