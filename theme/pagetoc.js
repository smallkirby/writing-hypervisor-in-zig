// https://github.com/JorelAli/mdBook-pagetoc
/*
        DO WHAT THE FUCK YOU WANT TO PUBLIC LICENSE
                    Version 2, December 2004

 Copyright (C) 2024 smallkirby
 Copyright (C) 2020 Jorel Ali <contact@jorel.dev>

 Everyone is permitted to copy and distribute verbatim or modified
 copies of this license document, and changing it is allowed as long
 as the name is changed.

            DO WHAT THE FUCK YOU WANT TO PUBLIC LICENSE
   TERMS AND CONDITIONS FOR COPYING, DISTRIBUTION AND MODIFICATION

  0. You just DO WHAT THE FUCK YOU WANT TO.
*/

function forEach(elems, fun) {
  Array.prototype.forEach.call(elems, fun);
}

function getPagetoc(){
  return document.getElementsByClassName("pagetoc")[0]
}

function getPagetocElems() {
  return getPagetoc().children;
}

function getHeaders(){
  return document.getElementsByClassName("header")
}

// Un-active everything when you click it
function forPagetocElem(fun) {
  forEach(getPagetocElems(), fun);
}

function getRect(element) {
  return element.getBoundingClientRect();
}

function overflowTop(container, element) {
  return getRect(container).top - getRect(element).top;
}

function overflowBottom(container, element) {
  return getRect(container).bottom - getRect(element).bottom;
}

var activeHref = location.href;

var updateFunction = function (elem = undefined) {
  var id = elem;

  if (!id && location.href != activeHref) {
    activeHref = location.href;
    forPagetocElem(function (el) {
      if (el.href === activeHref) {
        id = el;
      }
    });
  }

  if (!id) {
    var elements = getHeaders();
    let margin = window.innerHeight / 3;

    forEach(elements, function (el, i, arr) {
      if (!id && getRect(el).top >= 0) {
        if (getRect(el).top < margin) {
          id = el;
        } else {
          id = arr[Math.max(0, i - 1)];
        }
      }
      // a very long last section
      // its heading is over the screen
      if (!id && i == arr.length - 1) {
        id = el
      }
    });
  }

  forPagetocElem(function (el) {
    el.classList.remove("active");
  });

  if (!id) return;

  forPagetocElem(function (el) {
    if (id.href.localeCompare(el.href) == 0) {
      el.classList.add("active");
      let pagetoc = getPagetoc();
      if (overflowTop(pagetoc, el) > 0) {
        pagetoc.scrollTop = el.offsetTop;
      }
      if (overflowBottom(pagetoc, el) < 0) {
        pagetoc.scrollTop -= overflowBottom(pagetoc, el);
      }
    }
  });
};

let elements = getHeaders();

const is_toppage = location.pathname.endsWith("intro.html");
if (!is_toppage) {
  if (elements.length > 1) {
    // Populate sidebar on load
    window.addEventListener("load", function () {
      var pagetoc = getPagetoc();
      var elements = getHeaders();
      forEach(elements, function (el) {
        var link = document.createElement("a");
        link.appendChild(document.createTextNode(el.text));
        link.href = el.hash;
        link.classList.add("pagetoc-" + el.parentElement.tagName);
        pagetoc.appendChild(link);
        link.onclick = function () {
          updateFunction(link);
        };
      });
      updateFunction();
    });

    // Handle active elements on scroll
    window.addEventListener("scroll", function () {
      updateFunction();
    });
  } else {
    document.getElementsByClassName("sidetoc")[0].remove();
  }
}
