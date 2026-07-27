import type { ToolDef } from "../lib/toolDef.js";
import { createPoTicket } from "./createPoTicket.js";
import { createDevTicket } from "./createDevTicket.js";
import { getSprint } from "./getSprint.js";
import { getTicket } from "./getTicket.js";
import { updateTicket } from "./updateTicket.js";
import { getDailyHuddle } from "./getDailyHuddle.js";
import { createSprintTool } from "./createSprint.js";
import { listSprintsTool } from "./listSprints.js";
import { getSprintReportTool } from "./getSprintReport.js";
import { getVelocityTool } from "./getVelocity.js";
import { getMultiSprintReportTool } from "./getMultiSprintReport.js";
import { getLeavesTool } from "./getLeaves.js";
import { getAllLeavesTool } from "./getAllLeaves.js";
import { setLeavesTool } from "./setLeaves.js";
import { getAssignableUsersTool } from "./getAssignableUsers.js";
import { assignIssueTool } from "./assignIssue.js";
import { getRecentAssigneesTool } from "./getRecentAssignees.js";
import { getTeamMembersTool } from "./getTeamMembers.js";
import { setTeamMembersTool } from "./setTeamMembers.js";
import { getLinkedIssuesTool } from "./getLinkedIssues.js";
import { getIssueDescriptionsTool } from "./getIssueDescriptions.js";
import { setSprintGoalTool } from "./setSprintGoal.js";
import { getTransitionsTool } from "./getTransitions.js";
import { transitionIssueTool } from "./transitionIssue.js";
import { moveIssueToSprintTool } from "./moveIssueToSprint.js";
import { getImpedimentsTool } from "./getImpediments.js";
import { setImpedimentsTool } from "./setImpediments.js";
import { getPullRequestsTool } from "./getPullRequests.js";
import { setPullRequestsTool } from "./setPullRequests.js";
import { getPostScrumTool } from "./getPostScrum.js";
import { setPostScrumTool } from "./setPostScrum.js";
import { getMeetingGoalTool } from "./getMeetingGoal.js";
import { setMeetingGoalTool } from "./setMeetingGoal.js";
import { getMeetingNotes } from "./getMeetingNotes.js";
import { setMeetingNotes } from "./setMeetingNotes.js";
import { getRetro } from "./getRetro.js";
import { setRetro } from "./setRetro.js";
import { getIssuePullRequestsTool } from "./getIssuePullRequests.js";
import { getOffsetLedgerTool } from "./getOffsetLedger.js";
import { setOffsetForSprintTool } from "./setOffsetForSprint.js";
import { setOffsetAdjustmentTool } from "./setOffsetAdjustment.js";
import { addOffsetAdjustmentTool } from "./addOffsetAdjustment.js";
import { deleteOffsetAdjustmentTool } from "./deleteOffsetAdjustment.js";
import { getDraftPlanTool } from "./getDraftPlan.js";
import { setDraftPlanTool } from "./setDraftPlan.js";
import { linkDevToPo } from "./linkDevToPo.js";
import { unlinkDevFromPo } from "./unlinkDevFromPo.js";

export const tools: ToolDef[] = [
  createPoTicket,
  createDevTicket,
  getSprint,
  getTicket,
  updateTicket,
  getDailyHuddle,
  createSprintTool,
  listSprintsTool,
  getSprintReportTool,
  getVelocityTool,
  getMultiSprintReportTool,
  getLeavesTool,
  getAllLeavesTool,
  setLeavesTool,
  getAssignableUsersTool,
  assignIssueTool,
  getRecentAssigneesTool,
  getTeamMembersTool,
  setTeamMembersTool,
  getLinkedIssuesTool,
  getIssueDescriptionsTool,
  setSprintGoalTool,
  getTransitionsTool,
  transitionIssueTool,
  moveIssueToSprintTool,
  getImpedimentsTool,
  setImpedimentsTool,
  getPullRequestsTool,
  setPullRequestsTool,
  getPostScrumTool,
  setPostScrumTool,
  getMeetingGoalTool,
  setMeetingGoalTool,
  getMeetingNotes,
  setMeetingNotes,
  getRetro,
  setRetro,
  getIssuePullRequestsTool,
  getOffsetLedgerTool,
  setOffsetForSprintTool,
  setOffsetAdjustmentTool,
  addOffsetAdjustmentTool,
  deleteOffsetAdjustmentTool,
  getDraftPlanTool,
  setDraftPlanTool,
  linkDevToPo,
  unlinkDevFromPo,
];
