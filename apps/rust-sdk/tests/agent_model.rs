use firecrawl::AgentModel;

#[test]
fn deserializes_every_known_model() {
    for (name, expected) in [
        ("spark-2", AgentModel::Spark2),
        ("spark-1-pro", AgentModel::Spark1Pro),
        ("spark-1-mini", AgentModel::Spark1Mini),
    ] {
        let parsed: AgentModel = serde_json::from_str(&format!("\"{name}\""))
            .unwrap_or_else(|e| panic!("{name} should deserialize: {e}"));
        assert_eq!(parsed, expected);
        assert_eq!(serde_json::to_string(&expected).unwrap(), format!("\"{name}\""));
    }
}

#[test]
fn unrecognized_model_degrades_instead_of_failing_the_parse() {
    // /v2/agent/:id always returns `model`. A model the server ships before this
    // SDK knows about must not take down status polling.
    let parsed: AgentModel = serde_json::from_str("\"spark-9-unreleased\"")
        .expect("unknown model should deserialize");
    assert_eq!(parsed, AgentModel::Unknown);
}
