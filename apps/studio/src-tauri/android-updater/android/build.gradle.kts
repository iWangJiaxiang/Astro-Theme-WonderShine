import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

val releaseRepo = System.getenv("VITE_STUDIO_RELEASE_REPOSITORY") ?: "iWangJiaxiang/Astro-Theme-WonderShine"
require(Regex("[A-Za-z0-9-]+/[A-Za-z0-9_.-]+").matches(releaseRepo))

android {
    namespace = "wang.jiaxiang.studio.updates"
    compileSdk = 36
    buildFeatures { buildConfig = true }
    defaultConfig {
        minSdk = 24
        buildConfigField("String", "REPOSITORY", "\"" + releaseRepo + "\"")
        consumerProguardFiles("consumer-rules.pro")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
}

kotlin { compilerOptions { jvmTarget = JvmTarget.JVM_1_8 } }
dependencies {
    implementation(project(":tauri-android"))
    implementation("androidx.appcompat:appcompat:1.7.1")
}
