using System.Text.Json.Serialization;

namespace Firecrawl.Models;

/// <summary>
/// Web search results.
/// </summary>
public class SearchData
{
    [JsonPropertyName("web")]
    public List<Document>? Web { get; set; }

    [JsonPropertyName("news")]
    public List<Document>? News { get; set; }

    [JsonPropertyName("images")]
    public List<object>? Images { get; set; }
}
