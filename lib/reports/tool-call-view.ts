/**
 * The serializable slice of a TrueForge ToolCallDetail a lifecycle row needs for its hover.
 *
 * Its own module rather than a type on the component, because the route handler that serves it
 * and the client query that reads it both need the shape, and neither should have to import a
 * React component to get at it.
 */
export type ToolCallView = {
  toolName: string;
  argumentsJson: string;
  result: string | null;
};
