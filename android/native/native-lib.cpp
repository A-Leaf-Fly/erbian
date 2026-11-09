// 耳边 · 本地引擎：把 libnode 跑在独立线程里，暴露给 Java 调用。
// 只声明 node::Start(int,char**)，不 include node.h —— 避免 V8 头文件带来的编译期 ABI 约束。

#include <jni.h>
#include <pthread.h>
#include <unistd.h>
#include <cstdlib>
#include <cstring>
#include <android/log.h>

#define TAG "ErbianNode"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

namespace node {
int Start(int argc, char *argv[]);
}

static JavaVM *g_vm = nullptr;
static jobject g_listener = nullptr;
static int g_argc = 0;
static char **g_argv = nullptr;
static volatile int g_running = 0;
static volatile int g_exitCode = -1;

static void report_exit(int code) {
    JNIEnv *env = nullptr;
    bool attached = false;
    if (g_vm) {
        jint r = g_vm->GetEnv((void **) &env, JNI_VERSION_1_6);
        if (r == JNI_EDETACHED) {
            if (g_vm->AttachCurrentThread(&env, nullptr) == JNI_OK) attached = true;
        }
    }
    if (env && g_listener) {
        jclass cls = env->GetObjectClass(g_listener);
        if (cls) {
            jmethodID mid = env->GetMethodID(cls, "onNodeExit", "(I)V");
            if (mid) env->CallVoidMethod(g_listener, mid, code);
            env->DeleteLocalRef(cls);
        }
        if (env->ExceptionCheck()) env->ExceptionClear();
    }
    if (attached && g_vm) g_vm->DetachCurrentThread();
}

static void *node_main(void *) {
    LOGI("node thread start, argc=%d", g_argc);
    g_running = 1;
    int code = node::Start(g_argc, g_argv);
    g_running = 0;
    g_exitCode = code;
    LOGE("node exited, code=%d", code);
    report_exit(code);
    return nullptr;
}

static void set_env_array(JNIEnv *env, jobjectArray kv) {
    if (!kv) return;
    jsize n = env->GetArrayLength(kv);
    for (jsize i = 0; i < n; i++) {
        jstring s = (jstring) env->GetObjectArrayElement(kv, i);
        if (!s) continue;
        const char *c = env->GetStringUTFChars(s, nullptr);
        if (c) {
            const char *eq = strchr(c, '=');
            if (eq && eq != c) {
                char *key = strndup(c, (size_t) (eq - c));
                setenv(key, eq + 1, 1);
                LOGI("env %s=%s", key, eq + 1);
                free(key);
            }
            env->ReleaseStringUTFChars(s, c);
        }
        env->DeleteLocalRef(s);
    }
}

extern "C" JNIEXPORT jint JNICALL
Java_app_erbian_player_NodeEngine_nativeStart(JNIEnv *env, jclass, jobjectArray args,
                                              jstring workDir, jobjectArray envVars,
                                              jobject listener) {
    if (g_running) {
        LOGI("node already running");
        return 1;
    }

    env->GetJavaVM(&g_vm);
    if (g_listener) env->DeleteGlobalRef(g_listener);
    g_listener = listener ? env->NewGlobalRef(listener) : nullptr;

    const char *wd = env->GetStringUTFChars(workDir, nullptr);
    if (!wd || chdir(wd) != 0) {
        LOGE("chdir failed: %s", wd ? wd : "(null)");
        if (wd) env->ReleaseStringUTFChars(workDir, wd);
        return -2;
    }
    LOGI("cwd = %s", wd);
    env->ReleaseStringUTFChars(workDir, wd);

    set_env_array(env, envVars);

    jsize n = args ? env->GetArrayLength(args) : 0;
    if (g_argv) {
        for (int i = 0; i < g_argc; i++) free(g_argv[i]);
        free(g_argv);
        g_argv = nullptr;
    }
    g_argc = n;
    g_argv = (char **) calloc((size_t) n + 2, sizeof(char *));
    for (jsize i = 0; i < n; i++) {
        jstring s = (jstring) env->GetObjectArrayElement(args, i);
        const char *c = env->GetStringUTFChars(s, nullptr);
        g_argv[i] = strdup(c ? c : "");
        if (c) env->ReleaseStringUTFChars(s, c);
        env->DeleteLocalRef(s);
    }
    g_argv[n] = nullptr;

    pthread_t t;
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    // V8 需要大栈，Android 默认线程栈只有 1MB，容易栈溢出
    pthread_attr_setstacksize(&attr, 16 * 1024 * 1024);
    int rc = pthread_create(&t, &attr, node_main, nullptr);
    pthread_attr_destroy(&attr);
    if (rc != 0) {
        LOGE("pthread_create failed: %d", rc);
        return -3;
    }
    pthread_detach(t);
    return 0;
}

extern "C" JNIEXPORT jboolean JNICALL
Java_app_erbian_player_NodeEngine_nativeRunning(JNIEnv *, jclass) {
    return g_running ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT jint JNICALL
Java_app_erbian_player_NodeEngine_nativeExitCode(JNIEnv *, jclass) {
    return g_exitCode;
}
