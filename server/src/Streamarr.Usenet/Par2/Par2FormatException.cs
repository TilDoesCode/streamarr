namespace Streamarr.Usenet.Par2;

/// <summary>A PAR2 packet set is structurally invalid, inconsistent, or exceeds configured limits.</summary>
public sealed class Par2FormatException(string message) : Exception(message);
