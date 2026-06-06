import type { CommandAction, CommandRecord } from "@radio-bot/shared";

const resumeProfileActions = new Set<CommandAction>([
  "open_site",
  "login",
  "reload",
  "confirm_open_here",
  "play_radio"
]);

export type ResumeProfileSelection = {
  profileId: string;
  source: "recent_power_on" | "device_state" | "recent_command";
};

export function selectResumeProfile(input: {
  allowedProfileIds: string[];
  currentProfileId: string | null;
  commands: CommandRecord[];
  now?: number;
}): ResumeProfileSelection | null {
  const now = input.now ?? Date.now();
  const allowed = new Set(input.allowedProfileIds);
  const commands = [...input.commands].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const recentPowerOn = commands.find(
    (command) =>
      command.action === "power_on" &&
      Boolean(command.profileId) &&
      now - new Date(command.createdAt).getTime() <= 15 * 60 * 1000
  );

  if (recentPowerOn?.profileId && allowed.has(recentPowerOn.profileId)) {
    return {
      profileId: recentPowerOn.profileId,
      source: "recent_power_on"
    };
  }

  if (input.currentProfileId && allowed.has(input.currentProfileId)) {
    return {
      profileId: input.currentProfileId,
      source: "device_state"
    };
  }

  const recentCommand = commands.find(
    (command) =>
      Boolean(command.profileId) &&
      resumeProfileActions.has(command.action) &&
      (command.status === "succeeded" || command.status === "waiting_confirmation")
  );
  if (recentCommand?.profileId && allowed.has(recentCommand.profileId)) {
    return {
      profileId: recentCommand.profileId,
      source: "recent_command"
    };
  }

  return null;
}
