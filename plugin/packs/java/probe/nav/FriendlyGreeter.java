public final class FriendlyGreeter implements Greeter {
  @Override
  public String greet(String name) {
    return "Hello, " + name;
  }
}
