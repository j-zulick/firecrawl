plugins {
    `java-library`
    `maven-publish`
}

group = "com.firecrawl"
version = "1.0.0"

java {
    sourceCompatibility = JavaVersion.VERSION_11
    targetCompatibility = JavaVersion.VERSION_11
    withSourcesJar()
    withJavadocJar()
}

repositories {
    mavenCentral()
}

dependencies {
    api("com.squareup.okhttp3:okhttp:4.12.0")
    api("com.fasterxml.jackson.core:jackson-databind:2.17.2")
    api("com.fasterxml.jackson.core:jackson-annotations:2.17.2")
    api("com.fasterxml.jackson.datatype:jackson-datatype-jdk8:2.17.2")

    testImplementation("org.junit.jupiter:junit-jupiter:5.10.3")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher:1.10.3")
}

tasks.test {
    useJUnitPlatform()
}

tasks.withType<Javadoc> {
    options {
        (this as StandardJavadocDocletOptions).apply {
            addStringOption("Xdoclint:none", "-quiet")
        }
    }
}

publishing {
    publications {
        create<MavenPublication>("mavenJava") {
            from(components["java"])

            pom {
                name.set("Firecrawl Java SDK")
                description.set("Java SDK for the Firecrawl web scraping API")
                url.set("https://github.com/mendableai/firecrawl")

                licenses {
                    license {
                        name.set("MIT License")
                        url.set("https://opensource.org/licenses/MIT")
                    }
                }

                scm {
                    url.set("https://github.com/mendableai/firecrawl")
                    connection.set("scm:git:git://github.com/mendableai/firecrawl.git")
                    developerConnection.set("scm:git:ssh://github.com/mendableai/firecrawl.git")
                }
            }
        }
    }
}
