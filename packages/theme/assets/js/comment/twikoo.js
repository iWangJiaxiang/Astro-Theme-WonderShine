(() => {
    const page = document.getElementById('post-comment');
    const container = document.getElementById('twikoo-wrap');
    if (!container || !page) return
    const commentPath = document.getElementById('post-comment').dataset.commentPath || location.pathname.replace(/\/page\/\d$/, "");
    const init = () => {
        if (!page.isConnected) return;
        twikoo.init(Object.assign({
            el: '#twikoo-wrap',
            envId: GLOBAL_CONFIG.source.twikoo.twikooUrl,
            region: '',
            path: commentPath,
            onCommentLoaded: function () {
                if (!page.isConnected) return;
                typeof hljs === 'object' && hljs.highlightAll()
                typeof Prism === 'object' && Prism.highlightAllUnder(page)
                $("input").focus(function () {
                    wjx_intype = true;
                });
                $("textarea").focus(function () {
                    wjx_intype = true;
                });
                $("input").focusout(function () {
                    wjx_intype = false;
                });
                $("textarea").focusout(function () {
                    wjx_intype = false;
                });
            }
        }, null))
    }

    const getCount = () => {
        twikoo.getCommentsCount({
            envId: GLOBAL_CONFIG.source.twikoo.twikooUrl,
            region: '',
            urls: [commentPath],
            includeReply: true
        }).then(function (res) {
            if (page.isConnected && res[0]) {
                const count = document.getElementById('twikoo-count');
                if (count) count.innerText = res[0].count;
            }
        }).catch(function (err) {
        });
    }

    const runFn = () => {
        init()
        true && getCount()
    }

    const loadTwikoo = () => {
        if (typeof twikoo === 'object') {
            setTimeout(runFn, 0)
            return
        }
        getScript(GLOBAL_CONFIG.source.twikoo.js).then(runFn)
    }

    if ('Twikoo' === 'Twikoo' || !GLOBAL_CONFIG.source.comments.lazyload) {
        if (GLOBAL_CONFIG.source.comments.lazyload) btf.loadComment(document.getElementById('twikoo-wrap'), loadTwikoo)
        else loadTwikoo()
    } else {
        window.loadOtherComment = () => {
            loadTwikoo()
        }
    }


})()