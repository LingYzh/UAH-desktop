namespace UAH.ExecutionHelper;

/** Complete literal matches are masked before any byte reaches the spool.
 * KMP keeps cross-read and overlapping matches; a bounded difference ring marks
 * match intervals in O(1), avoiding a per-match walk over long credentials.
 */
internal sealed class LiteralByteFilter
{
    private sealed class Pattern
    {
        internal readonly byte[] Bytes;
        internal readonly int[] Prefix;
        internal int State;
        internal Pattern(byte[] bytes)
        {
            Bytes = bytes; Prefix = new int[bytes.Length];
            for (var index = 1; index < bytes.Length; index++)
            {
                var matched = Prefix[index - 1];
                while (matched > 0 && bytes[index] != bytes[matched]) matched = Prefix[matched - 1];
                if (bytes[index] == bytes[matched]) matched++;
                Prefix[index] = matched;
            }
        }
    }
    private readonly Pattern[] patterns;
    private readonly byte[] pending;
    private readonly int[] changes;
    private readonly int maxLength;
    private readonly byte maskByte;
    private long received, emitted;
    private int coverage;
    internal bool Matched { get; private set; }
    internal LiteralByteFilter(byte[][] secrets)
    {
        patterns = secrets.Select(bytes => new Pattern(bytes)).ToArray();
        // A printable credential can itself contain '*'. Choose NUL uniformly
        // for that execution's streams so masking cannot retain/create a key.
        maskByte = secrets.Any(bytes => Array.IndexOf(bytes, (byte)'*') >= 0) ? (byte)0 : (byte)'*';
        maxLength = secrets.Length == 0 ? 0 : secrets.Max(bytes => bytes.Length);
        pending = new byte[maxLength + 1]; changes = new int[maxLength + 1];
    }
    internal int Write(ReadOnlySpan<byte> input, Stream output)
    {
        if (maxLength == 0) { output.Write(input); return input.Length; }
        var ready = new byte[input.Length]; var count = 0;
        foreach (var value in input)
        {
            var position = received++;
            pending[(int)(position % pending.Length)] = value;
            foreach (var pattern in patterns)
            {
                while (pattern.State > 0 && value != pattern.Bytes[pattern.State]) pattern.State = pattern.Prefix[pattern.State - 1];
                if (value == pattern.Bytes[pattern.State]) pattern.State++;
                if (pattern.State == pattern.Bytes.Length)
                {
                    var start = position - pattern.Bytes.Length + 1;
                    changes[(int)(start % changes.Length)]++;
                    changes[(int)((position + 1) % changes.Length)]--;
                    Matched = true;
                    pattern.State = pattern.Prefix[pattern.State - 1];
                }
            }
            // No future match can touch this byte. Keep at most maxLength-1.
            if (received - emitted >= maxLength) ready[count++] = Emit();
        }
        output.Write(ready, 0, count); return count;
    }
    private byte Emit()
    {
        var index = (int)(emitted++ % changes.Length);
        coverage += changes[index]; changes[index] = 0;
        return coverage > 0 ? maskByte : pending[index];
    }
    internal int Flush(Stream output)
    {
        if (maxLength == 0) return 0;
        var tail = new byte[(int)(received - emitted)];
        for (var index = 0; index < tail.Length; index++) tail[index] = Emit();
        output.Write(tail); return tail.Length;
    }
}
