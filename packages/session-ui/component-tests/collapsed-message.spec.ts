import { expect, story } from "../../stories/playwright/story"

story("shows each message the user did not type as a collapsed bar", async ({ mount }) => {
  const root = await mount("current-session-collapsed-message--timeline")
  const parent = root.locator('[data-story-session="parent"]')
  const child = root.locator('[data-story-session="child"]')
  const bars = root.locator('[data-component="collapsed-message"] [data-slot="session-timeline-notice"]')

  await expect(bars).toHaveText([
    "Fork notice",
    "Skill · Review",
    /^Instructions updated\s*AGENTS\.md$/,
    "Task from parent agent",
  ])
  await expect(bars.first()).toHaveAttribute("aria-expanded", "false")
  await expect(root.locator('[data-slot="collapsed-message-text"]')).toHaveCount(0)
  await expect(parent.getByText("Fix the timeline setting that resets after a restart.")).toBeVisible()
  await expect(child.getByText("You are a subagent spawned by another session.", { exact: false })).toHaveCount(0)
  await expect(child.getByText("defaults to Compact", { exact: false })).toBeVisible()
})

story("shows a message the user typed in a subagent session in full", async ({ mount }) => {
  const child = (await mount("current-session-collapsed-message--timeline")).locator('[data-story-session="child"]')

  await expect(child.getByText("Also check where the setting is read.")).toBeVisible()
})

story("opens a collapsed bar to its full text and closes it again", async ({ mount }) => {
  const root = await mount("current-session-collapsed-message--bar")
  const bar = root.getByRole("button", { name: "Task from parent agent" })
  const text = root.locator('[data-slot="collapsed-message-text"]')

  await bar.click()
  await expect(bar).toHaveAttribute("aria-expanded", "true")
  await expect(text).toContainText("Find where the timeline setting is stored")
  await bar.click()
  await expect(text).toHaveCount(0)
  await bar.press("Enter")
  await expect(text).toBeVisible()
})
