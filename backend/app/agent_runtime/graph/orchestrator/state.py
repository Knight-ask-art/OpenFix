from langchain_core.messages import BaseMessage

from app.agent_runtime.graph.state import AgentRuntimeState


class OrchestratorState(AgentRuntimeState, total=False):
    """Parent PA graph state.

    The PA graph intentionally keeps one runtime node. Subagent routing lives in
    persisted AgentChildRun rows and dispatch tool results, not fixed graph edges.
    """

    parent_thread_id: str
    messages: list[BaseMessage]
    # Requested ReAct iteration cap, persisted so restarts and resumes reuse it.
    max_iterations: int
    # Structured reason for the last turn's stop, if it was not a natural finish.
    termination_reason: str | None
