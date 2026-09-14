interface Greeter {
  String greet(String name)
}

class FriendlyGreeter implements Greeter {
  String greet(String name) {
    "Hello, $name"
  }
}
